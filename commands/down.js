const { ButtonBuilder, ActionRowBuilder, ButtonStyle, StringSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const ms = require('ms');
const colorManager = require('../utils/colorManager');
const downManager = require('../utils/downManager');

const name = 'down';

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
    const settingsPath = path.join(__dirname, '..', 'data', 'downSettings.json');
    const settings = readJson(settingsPath, {});

    return !settings.menuChannel || !settings.logChannel || !settings.allowedUsers?.type;
}

// Create setup status embed
function createSetupEmbed(step, settings = {}, client) {
    const embed = colorManager.createEmbed()
        .setTitle('Down System Setup')
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
        const channel = await client.channels.fetch(channelId);
        if (!channel) return false;

        const settings = downManager.getSettings();
        const menuEmbed = colorManager.createEmbed()
            .setTitle('Down Management System')
            .setDescription('استخدم القائمة أدناه لإدارة الداون والرولات الإدارية')
            .addFields([
                { name: 'Down', value: 'سحب رول إداري من عضو لمدة محددة أو نهائياً', inline: false },
                { name: 'Record', value: 'عرض تاريخ الداون لعضو معين', inline: false },
                { name: 'Change', value: 'تعديل مدة داون حالي', inline: false },
                { name: 'Active', value: 'عرض جميع الداونات الجارية', inline: false },
                { name: 'Finish', value: 'إنهاء أو مراجعة داونات عضو معين', inline: false }
            ])
            .setThumbnail(client?.user?.displayAvatarURL() || 'https://cdn.discordapp.com/attachments/1373799493111386243/1400677612304470086/images__5_-removebg-preview.png?ex=688d822e&is=688c30ae&hm=1ea7a63bb89b38bcd76c0f5668984d7fc919214096a3d3ee92f5d948497fcb51&')
            .setFooter({ text: 'Down System' })
            .setTimestamp();

        const menuSelect = new StringSelectMenuBuilder()
            .setCustomId('down_main_menu')
            .setPlaceholder('اختر الإجراء المطلوب...')
            .addOptions([
                {
                    label: 'Down',
emoji: '<:emoji_70:1442588577795149947>',
                    value: 'remove_role',
                    description: 'سحب رول إداري من عضو لمدة محددة أو نهائياً'
                },
                {
                    label: 'Record',
emoji: '<:emoji_68:1442588491585294358>',
                    value: 'user_records',
                    description: 'عرض تاريخ الداون لعضو معين'
                },
                {
                    label: 'Change',
emoji: '<:emoji_82:1442589171519586345>',
                    value: 'modify_duration',
                    description: 'تعديل مدة داون حالي'
                },
                {
                    label: 'Active',
emoji: '<:emoji_79:1442589038279266384>',
                    value: 'active_downs',
                    description: 'عرض جميع الداونات الجارية ووقت انتهائها'
                },
                {
                    label: 'Finish',
emoji: '<:emoji_77:1442588896008339579>',
                    value: 'user_downs',
                    description: 'إنهاء أو مراجعة داونات عضو معين'
                }
            ]);

        const settingsButton = new ButtonBuilder()
            .setCustomId('down_settings_button')
            .setLabel('Settings')
.setEmoji('<:emoji_70:1442588619368960213>')
            .setStyle(ButtonStyle.Secondary);

        const menuRow = new ActionRowBuilder().addComponents(menuSelect);
        const buttonRow = new ActionRowBuilder().addComponents(settingsButton);

        // Always create new menu message when called from resend
        let message = null;

        // Check if we have an existing menu message to update (only if menuMessageId exists)
        if (settings.menuMessageId) {
            try {
                const existingMessage = await channel.messages.fetch(settings.menuMessageId);
                message = await existingMessage.edit({
                    embeds: [menuEmbed],
                    components: [menuRow, buttonRow]
                });
                console.log('تم تحديث المنيو الموجود');
                return true;
            } catch (error) {
                // Message doesn't exist anymore, create new one
                console.log('Previous menu message not found, creating new one');
                settings.menuMessageId = null;
            }
        }

        // Create new menu message
        try {
            message = await channel.send({
                embeds: [menuEmbed],
                components: [menuRow, buttonRow]
            });

            // Store the message ID for future updates
            settings.menuMessageId = message.id;
            downManager.updateSettings(settings);

            console.log(`تم إنشاء منيو جديد برقم: ${message.id}`);
            return true;
        } catch (error) {
            console.error('خطأ في إنشاء المنيو الجديد:', error);
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
        const settingsPath = path.join(__dirname, '..', 'data', 'downSettings.json');
        const settings = readJson(settingsPath, {});

        const noPermEmbed = colorManager.createEmbed()
            .setDescription(' **هذا الأمر مخصص للمالكين فقط!**\n\n**للاستخدام العادي:** توجه للمنيو التفاعلي في الروم المحددة.');

        if (settings.menuChannel) {
            noPermEmbed.addFields([
                { name: ' روم المنيو', value: `<#${settings.menuChannel}>`, inline: true }
            ]);
        }

        return message.reply({ embeds: [noPermEmbed] });
    }

    // Check if setup is needed
    if (needsSetup()) {
        const setupEmbed = createSetupEmbed(1, {}, client);

        const setupSelect = new StringSelectMenuBuilder()
            .setCustomId('down_setup_permission')
            .setPlaceholder('اختر نوع المعتمدين...')
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

                },
                {
                    label: 'مسؤوليات محددة',
                    value: 'responsibility',
                    description: 'السماح للمسؤولين عن مسؤوليات معينة',
                }
            ]);

        const setupRow = new ActionRowBuilder().addComponents(setupSelect);

        return message.reply({
            embeds: [setupEmbed],
            components: [setupRow],
            content: '**مرحباً بك في إعداد نظام الداون!**\n\nيرجى اتباع الخطوات التالية لإكمال الإعداد:'
        });
    }

    // If setup is complete, show admin management menu
    const settingsPath = path.join(__dirname, '..', 'data', 'downSettings.json');
    const settings = readJson(settingsPath, {});

    const adminEmbed = colorManager.createEmbed()
        .setTitle('Down System Management')
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
        .setCustomId('down_quick_actions')
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
                description: 'عرض إحصائيات الداونات والاستخدام',
            }
        ]);

    const actionRow = new ActionRowBuilder().addComponents(quickActionsSelect);

    await message.reply({ embeds: [adminEmbed], components: [actionRow] });
}

async function handleInteraction(interaction, context) {
    try {
        const { client, BOT_OWNERS } = context;
        const customId = interaction.customId;

        // Check interaction validity
        if (interaction.replied || interaction.deferred) {
            console.log('Interaction already processed');
            return;
        }

                // Defer immediately if not a modal, and not a modal-triggering select menu
                const isModalTrigger = 
                    (interaction.isStringSelectMenu() && (customId === 'down_role_selection' || customId === 'down_select_down_to_modify' || customId === 'down_select_down_to_end')) ||
                    (interaction.isModalSubmit());
        
                // Interactions that should NOT be deferred (because they lead to a modal or are already a modal submission)
                if (isModalTrigger) {
                    // Do nothing, the next step will be showModal or modal submission handling
                } else {
                    // Interactions that should be deferred (buttons, user selects that don't lead to modal, etc.)
                    const isSetupSelect = customId.startsWith('down_setup_');
                    const isMainMenu = customId === 'down_main_menu';
                    const isDurationUserSelect = customId === 'down_select_user_for_duration_modify';
                    
            // We defer everything else, except the setup selects and main menu select (which use update/editReply later)
            if (!isSetupSelect && !isMainMenu && !isDurationUserSelect) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(err => {
                    // Ignore "Unknown interaction" error (10062) if it was already replied/deferred elsewhere
                    if (err.code !== 10062) console.log('Defer error:', err.message);
                });
            }
        }
        console.log(`معالجة تفاعل down: ${customId}`);

        // Handle quick admin actions
        if (customId === 'down_quick_actions') {
            await handleQuickActions(interaction, context);
            return;
        }

        // Handle main menu interactions
        if (customId === 'down_main_menu') {
            const hasPermission = await downManager.hasPermission(interaction, BOT_OWNERS);
            if (!hasPermission) {
                const response = { content: ' **لا تسوي خوي!**', flags: MessageFlags.Ephemeral };
                if (interaction.deferred) await interaction.editReply(response);
                else await interaction.reply(response);
                return;
            }
            // If it's the main menu, we should use update or reply, not editReply if we didn't defer
            await handleMainMenu(interaction, context);
            return;
        }

        // Handle settings button
        if (customId === 'down_settings_button') {
            const hasPermission = await downManager.hasPermission(interaction, BOT_OWNERS);
            if (!hasPermission) {
                const response = { content: ' **لا تسوي خوي!**', flags: MessageFlags.Ephemeral };
                if (interaction.deferred) await interaction.editReply(response);
                else await interaction.reply(response);
                return;
            }
            await handleSettingsButton(interaction, context);
            return;
        }

        // Handle setup interactions
        if (customId.startsWith('down_setup_')) {
            await handleSetupStep(interaction, context);
            return;
        }

        // Handle other down interactions
        await handleDownInteractions(interaction, context);

    } catch (error) {
        console.error('خطأ في معالجة تفاعل down:', error);

        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: ' **حدث خطأ أثناء المعالجة! يرجى المحاولة مرة أخرى.**',
                    ephemeral: true
                }).catch(() => {});
            } else if (interaction.deferred) {
                await interaction.editReply({
                    content: ' **حدث خطأ أثناء المعالجة! يرجى المحاولة مرة أخرى.**'
                }).catch(() => {});
            }
        } catch (replyError) {
            console.error('فشل في الرد على الخطأ:', replyError);
        }
    }
}

async function handleSetupStep(interaction, context) {
    const { client, BOT_OWNERS } = context;
    const settingsPath = path.join(__dirname, '..', 'data', 'downSettings.json');
    const settings = readJson(settingsPath, {
        menuChannel: null,
        logChannel: null,
        allowedUsers: { type: null, targets: [] }
    });

    if (interaction.customId === 'down_setup_permission') {
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
                .setCustomId('down_setup_log_channel')
                .setPlaceholder(' اختر قناة السجلات...')
                .setChannelTypes([ChannelType.GuildText]);

            const channelRow = new ActionRowBuilder().addComponents(channelSelect);

            if (interaction.replied || interaction.deferred) {
                await interaction.editReply({
                    embeds: [setupEmbed],
                    components: [channelRow]
                });
            } else {
                await interaction.update({
                    embeds: [setupEmbed],
                    components: [channelRow]
                });
            }
        } else if (selectedType === 'roles') {
            // Roles selected - show role selector
            settings.allowedUsers.targets = []; // Reset targets for new selection
            saveJson(settingsPath, settings);

            const setupEmbed = createSetupEmbed(1, settings, client);
            setupEmbed.setDescription('اختر الرولات المعتمدة لاستخدام نظام الداون');

            const roleSelect = new RoleSelectMenuBuilder()
                .setCustomId('down_setup_select_roles')
                .setPlaceholder(' اختر الرولات المعتمدة...')
                .setMaxValues(10);

            const roleRow = new ActionRowBuilder().addComponents(roleSelect);

            if (interaction.replied || interaction.deferred) {
                await interaction.editReply({
                    embeds: [setupEmbed],
                    components: [roleRow]
                });
            } else {
                await interaction.update({
                    embeds: [setupEmbed],
                    components: [roleRow]
                });
            }

        } else if (selectedType === 'responsibility') {
            // Responsibility selected - show available responsibilities
            settings.allowedUsers.targets = []; // Reset targets for new selection
            const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
            const responsibilities = readJson(responsibilitiesPath, {});

            if (Object.keys(responsibilities).length === 0) {
                const noRespEmbed = colorManager.createEmbed()
                    .setTitle('⚠️ لا توجد مسؤوليات')
                    .setDescription('لا توجد مسؤوليات معرّفة في النظام!\n\nيرجى استخدام أمر `settings` أولاً لإضافة مسؤوليات.')
                    .addFields([
                        { name: '💡 نصيحة', value: 'يمكنك اختيار "المالكين فقط" أو "رولات محددة" بدلاً من ذلك', inline: false }
                    ]);

                const backSelect = new StringSelectMenuBuilder()
                    .setCustomId('down_setup_permission')
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

                if (interaction.replied || interaction.deferred) {
                    await interaction.editReply({
                        embeds: [noRespEmbed],
                        components: [backRow]
                    });
                } else {
                    await interaction.update({
                        embeds: [noRespEmbed],
                        components: [backRow]
                    });
                }
                return;
            }

            // Show responsibility selector
            saveJson(settingsPath, settings);

            const setupEmbed = createSetupEmbed(1, settings, client);
            setupEmbed.setDescription('اختر المسؤوليات المعتمدة لاستخدام نظام الداون');

            const respOptions = Object.entries(responsibilities).slice(0, 25).map(([name, data]) => ({
                label: name,
                value: name,
                description: `السماح للمسؤولين عن ${name}`
            }));

            const respSelect = new StringSelectMenuBuilder()
                .setCustomId('down_setup_select_responsibilities')
                .setPlaceholder(' اختر المسؤوليات المعتمدة...')
                .setMaxValues(Math.min(respOptions.length, 10))
                .addOptions(respOptions);

            const respRow = new ActionRowBuilder().addComponents(respSelect);

            if (interaction.replied || interaction.deferred) {
                await interaction.editReply({
                    embeds: [setupEmbed],
                    components: [respRow]
                });
            } else {
                await interaction.update({
                    embeds: [setupEmbed],
                    components: [respRow]
                });
            }
        }
        return;
    }

    // Handle role selection for setup
    if (interaction.customId === 'down_setup_select_roles') {
        settings.allowedUsers.targets = interaction.values;
        saveJson(settingsPath, settings);

        // Move to log channel selection
        const setupEmbed = createSetupEmbed(2, settings, client);

        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId('down_setup_log_channel')
            .setPlaceholder(' اختر قناة السجلات...')
            .setChannelTypes([ChannelType.GuildText]);

        const channelRow = new ActionRowBuilder().addComponents(channelSelect);

        if (interaction.replied || interaction.deferred) {
            await interaction.editReply({
                embeds: [setupEmbed],
                components: [channelRow]
            });
        } else {
            await interaction.update({
                embeds: [setupEmbed],
                components: [channelRow]
            });
        }
        return;
    }

    // Handle responsibility selection for setup
    if (interaction.customId === 'down_setup_select_responsibilities') {
        settings.allowedUsers.targets = interaction.values;
        saveJson(settingsPath, settings);

        // Move to log channel selection
        const setupEmbed = createSetupEmbed(2, settings, client);

        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId('down_setup_log_channel')
            .setPlaceholder(' اختر قناة السجلات...')
            .setChannelTypes([ChannelType.GuildText]);

        const channelRow = new ActionRowBuilder().addComponents(channelSelect);

        if (interaction.replied || interaction.deferred) {
            await interaction.editReply({
                embeds: [setupEmbed],
                components: [channelRow]
            });
        } else {
            await interaction.update({
                embeds: [setupEmbed],
                components: [channelRow]
            });
        }
        return;
    }

    // Handle log channel selection
    if (interaction.customId === 'down_setup_log_channel') {
        const logChannelId = interaction.values[0];
        settings.logChannel = logChannelId;
        saveJson(settingsPath, settings);

        // Move to menu channel selection
        const setupEmbed = createSetupEmbed(3, settings, client);

        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId('down_setup_menu_channel')
            .setPlaceholder(' اختر قناة المنيو...')
            .setChannelTypes([ChannelType.GuildText]);

        const channelRow = new ActionRowBuilder().addComponents(channelSelect);

        if (interaction.replied || interaction.deferred) {
            await interaction.editReply({
                embeds: [setupEmbed],
                components: [channelRow]
            });
        } else {
            await interaction.update({
                embeds: [setupEmbed],
                components: [channelRow]
            });
        }
        return;
    }

    // Handle menu channel selection - final step
    if (interaction.customId === 'down_setup_menu_channel') {
        const menuChannelId = interaction.values[0];
        settings.menuChannel = menuChannelId;
        saveJson(settingsPath, settings);

        // Setup complete - create permanent menu
        const success = await createPermanentMenu(client, menuChannelId);
        const targetsCount = (settings.allowedUsers && settings.allowedUsers.targets) ? settings.allowedUsers.targets.length : 0;

        const completeEmbed = colorManager.createEmbed()
            .setTitle('Setup Complete Successfully')
            .setDescription('تم إعداد نظام الداون بنجاح وهو جاهز للاستخدام الآن')
            .addFields([
                { name: ' المعتمدين', value: `${getPermissionTypeText(settings.allowedUsers.type)} (${targetsCount})`, inline: true },
                { name: ' روم السجلات', value: `<#${settings.logChannel}>`, inline: true },
                { name: ' روم المنيو', value: `<#${settings.menuChannel}>`, inline: true },
                { name: ' حالة المنيو', value: success ? ' تم إرساله بنجاح' : ' فشل في الإرسال', inline: false }
            ])
            .setThumbnail(client?.user?.displayAvatarURL() || 'https://cdn.discordapp.com/attachments/1373799493111386243/1400677612304470086/images__5_-removebg-preview.png?ex=688d822e&is=688c30ae&hm=1ea7a63bb89b38bcd76c0f5668984d7fc919214096a3d3ee92f5d948497fcb51&')
            .setFooter({ text: 'يمكن للمستخدمين الآن استخدام النظام من روم المحددة' })
            .setTimestamp();

        if (!success) {
            completeEmbed.addFields([
                { name: '⚠️ تنبيه', value: 'فشل في إرسال المنيو التلقائي. يرجى التأكد من صلاحيات البوت في القناة المحددة.', inline: false }
            ]);
        }

        if (interaction.replied || interaction.deferred) {
            await interaction.editReply({
                embeds: [completeEmbed],
                components: []
            });
        } else {
            await interaction.update({
                embeds: [completeEmbed],
                components: []
            });
        }
        return;
    }
}

async function handleQuickActions(interaction, context) {
    const { client } = context;
    const selectedAction = interaction.values[0];
    const settingsPath = path.join(__dirname, '..', 'data', 'downSettings.json');
    const settings = readJson(settingsPath, {});

    switch (selectedAction) {
        case 'remove_role':
            await handleRemoveRole(interaction, context);
            break;
        case 'user_records':
            await handleUserRecords(interaction, context);
            break;
        case 'modify_duration':
            await handleModifyDuration(interaction, context);
            break;
        case 'active_downs':
            await handleActiveDowns(interaction, context);
            break;
        case 'user_downs':
            await handleUserDowns(interaction, context);
            break;
        case 'resend_menu':
            if (!settings.menuChannel) {
                await interaction.reply({
                    content: ' **لم يتم تحديد قناة المنيو! يرجى إعادة إعداد النظام.**',
                    ephemeral: true
                });
                return;
            }

            const success = await createPermanentMenu(client, settings.menuChannel);

            await interaction.reply({
                content: success ?
                    ` **تم إرسال المنيو التفاعلي إلى** <#${settings.menuChannel}>` :
                    ` **فشل في إرسال المنيو إلى** <#${settings.menuChannel}>`,
                ephemeral: true
            });
            break;

        case 'edit_settings':
            await handleEditSettings(interaction, context);
            break;

        case 'system_stats':
            const statsEmbed = await createSystemStats();
            await interaction.reply({
                embeds: [statsEmbed],
                ephemeral: true
            });
            break;
    }
}

async function createSystemStats() {
    const activeDownsPath = path.join(__dirname, '..', 'data', 'activeDowns.json');
    const downHistoryPath = path.join(__dirname, '..', 'data', 'downHistory.json');

    const activeDowns = readJson(activeDownsPath, {});
    const history = readJson(downHistoryPath, []);

    const activeCount = Object.keys(activeDowns).length;
    const totalHistory = history.length;

    // Calculate stats
    const today = new Date().toDateString();
    const todayCount = history.filter(record =>
        new Date(record.timestamp).toDateString() === today
    ).length;

    const thisWeek = new Date();
    thisWeek.setDate(thisWeek.getDate() - 7);
    const weekCount = history.filter(record =>
        new Date(record.timestamp) >= thisWeek
    ).length;

    return colorManager.createEmbed()
        .setTitle('Down System Statistics')
        .setDescription('إحصائيات شاملة حول استخدام النظام')
        .addFields([
            { name: ' الداونات النشطة', value: `${activeCount} داون`, inline: true },
            { name: ' إجمالي السجلات', value: `${totalHistory} سجل`, inline: true },
            { name: ' اليوم', value: `${todayCount} داون جديد`, inline: true },
            { name: ' هذا الأسبوع', value: `${weekCount} داون`, inline: true },
            { name: 'حجم البيانات', value: `${(JSON.stringify(activeDowns).length / 1024).toFixed(1)} KB`, inline: true },
            { name: ' حالة النظام', value: ' يعمل بكفاءة', inline: true }
        ])
        .setTimestamp();
}

async function handleMainMenu(interaction, context) {
    const selectedValue = interaction.values[0];
    const { client } = context;

    const respond = async (data) => {
        try {
            if (interaction.deferred || interaction.replied) {
                return await interaction.editReply(data);
            } else {
                return await interaction.reply({ ...data, ephemeral: true });
            }
        } catch (e) {
            console.error('Respond error:', e.message);
        }
    };

    // Defer early to prevent timeout
    try {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ ephemeral: true }).catch(() => {});
        }
    } catch (e) {}

    switch (selectedValue) {
        case 'remove_role':
            await handleRemoveRole(interaction, context, respond);
            break;
        case 'user_records':
            await handleUserRecords(interaction, context, respond);
            break;
        case 'modify_duration':
            await handleModifyDuration(interaction, context, respond);
            break;
        case 'active_downs':
            await handleActiveDowns(interaction, context, respond);
            break;
        case 'user_downs':
            await handleUserDowns(interaction, context, respond);
            break;
    }

    // Refresh main menu after action
    try {
        const settings = downManager.getSettings();
        if (settings.menuChannel) {
            await createPermanentMenu(client, settings.menuChannel);
        }
    } catch (error) {
        console.error('Error refreshing menu:', error);
    }
}

async function handleSettingsButton(interaction, context) {
    const { BOT_OWNERS } = context;

    // Check if user is owner for settings
    if (!BOT_OWNERS.includes(interaction.user.id)) {
        return interaction.reply({
            content: ' **الإعدادات متاحة للمالكين فقط!**',
            ephemeral: true
        });
    }

    const settingsPath = path.join(__dirname, '..', 'data', 'downSettings.json');
    const settings = readJson(settingsPath, {});

    const settingsEmbed = colorManager.createEmbed()
        .setTitle('Down System Settings')
        .setDescription('إدارة إعدادات النظام والتحكم في الصلاحيات')
        .addFields([
            { name: ' المعتمدين', value: `${getPermissionTypeText(settings.allowedUsers?.type)} (${settings.allowedUsers?.targets?.length || 0})`, inline: true },
            { name: ' روم السجلات', value: settings.logChannel ? `<#${settings.logChannel}>` : 'غير محدد', inline: true },
            { name: ' روم المنيو', value: settings.menuChannel ? `<#${settings.menuChannel}>` : 'غير محدد', inline: true }
        ]);

    const settingsSelect = new StringSelectMenuBuilder()
        .setCustomId('down_owner_settings')
        .setPlaceholder('إدارة الإعدادات...')
        .addOptions([
            {
                label: 'إعادة إرسال المنيو',
                value: 'resend_menu',
                description: 'إرسال المنيو التفاعلي مرة أخرى',

            },
            {
                label: 'تعديل الإعدادات',
                value: 'edit_settings',
                description: 'تعديل الصلاحيات والقنوات',
            },
            {
                label: 'إحصائيات مفصلة',
                value: 'detailed_stats',
                description: 'عرض إحصائيات شاملة للنظام',
            },
            {
                label: 'إعادة تعيين النظام',
                value: 'reset_system',
                description: 'إعادة تعيين جميع الإعدادات',

            }
        ]);

    const settingsRow = new ActionRowBuilder().addComponents(settingsSelect);

    await interaction.reply({
        embeds: [settingsEmbed],
        components: [settingsRow],
        ephemeral: true
    });
}

// Import existing handlers from the previous version
async function handleRemoveRole(interaction, context, respond) {
    const userSelect = new UserSelectMenuBuilder()
        .setCustomId('down_selected_user')
        .setPlaceholder(' اختر العضو المراد سحب الرول منه...');

    const selectRow = new ActionRowBuilder().addComponents(userSelect);

    await respond({
        content: ' **اختر العضو المطلوب:**',
        components: [selectRow]
    });
}

async function handleUserRecords(interaction, context, respond) {
    const userSelect = new UserSelectMenuBuilder()
        .setCustomId('down_show_user_records')
        .setPlaceholder(' اختر العضو لعرض سجلاته...');

    const selectRow = new ActionRowBuilder().addComponents(userSelect);

    await respond({
        content: ' **اختر العضو لعرض سجلات الداون الخاصة به:**',
        components: [selectRow]
    });
}

async function handleModifyDuration(interaction, context, respond) {
    const activeDownsPath = path.join(__dirname, '..', 'data', 'activeDowns.json');
    const activeDowns = readJson(activeDownsPath, {});

    if (Object.keys(activeDowns).length === 0) {
        const noDownsEmbed = colorManager.createEmbed()
            .setDescription(' **لا توجد داونات نشطة حالياً للتعديل!**');

        await respond({ embeds: [noDownsEmbed] });
        return;
    }

    // Create a list of users who have active downs
    const usersWithDowns = {};
    for (const [downId, downData] of Object.entries(activeDowns)) {
        if (downData.roleId === null) continue; // Skip verbal downs from duration modify
        if (!usersWithDowns[downData.userId]) {
            usersWithDowns[downData.userId] = [];
        }
        usersWithDowns[downData.userId].push({ downId, ...downData });
    }

    // Create select menu with users who have active downs
    const userOptions = [];
    for (const [userId, userDowns] of Object.entries(usersWithDowns)) {
        try {
            const member = await interaction.guild.members.fetch(userId);
            userOptions.push({
                label: member.displayName,
                value: userId,
                description: `عدد الداونات: ${userDowns.length}`
            });
        } catch (error) {
            // User not found, skip
            continue;
        }
    }

    if (userOptions.length === 0) {
        const noValidDownsEmbed = colorManager.createEmbed()
            .setDescription(' **لا توجد داونات صالحة للتعديل!**');

        await respond({ embeds: [noValidDownsEmbed] });
        return;
    }

    const userSelect = new StringSelectMenuBuilder()
        .setCustomId('down_select_user_for_duration_modify')
        .setPlaceholder(' اختر العضو لتعديل مدة داونه...')
        .addOptions(userOptions.slice(0, 25)); // Discord limit

    const selectRow = new ActionRowBuilder().addComponents(userSelect);

    await respond({
        content: ' **اختر العضو لتعديل مدة الداون الخاص به:**',
        components: [selectRow]
    });
}

async function handleActiveDowns(interaction, context, respond) {
    const activeDownsPath = path.join(__dirname, '..', 'data', 'activeDowns.json');
    const activeDowns = readJson(activeDownsPath, {});

    if (Object.keys(activeDowns).length === 0) {
        const noDownsEmbed = colorManager.createEmbed()
            .setDescription(' **لا توجد داونات نشطة حالياً!**');

        await respond({ embeds: [noDownsEmbed] });
        return;
    }

    const embed = colorManager.createEmbed()
        .setTitle('Active Downs')
        .setDescription('جميع الداونات الجارية حالياً')
        .setTimestamp();

    let downsList = '';
    let count = 0;

    // Fix: iterate over the actual down records, not nested structure
    for (const [downId, downData] of Object.entries(activeDowns)) {
        if (count >= 10) break; // Limit to prevent embed overflow
        count++;

        const member = await interaction.guild.members.fetch(downData.userId).catch(() => null);
        const memberMention = member ? `<@${downData.userId}>` : `ID: ${downData.userId}`;

        const role = await interaction.guild.roles.fetch(downData.roleId).catch(() => null);
        const roleMention = role ? `<@&${downData.roleId}>` : `Role ID: ${downData.roleId}`;

        const endTime = downData.endTime ? `<t:${Math.floor(downData.endTime / 1000)}:R>` : 'نهائي';

        downsList += `**${count}.** ${memberMention}\n`;
        downsList += `└ **الرول :** ${roleMention}\n`;
        downsList += `└ **ينتهي :** ${endTime}\n`;
        downsList += `└ **السبب :** ${downData.reason.substring(0, 50)}${downData.reason.length > 50 ? '...' : ''}\n\n`;
    }

    if (downsList.length > 4000) {
        downsList = downsList.substring(0, 3900) + '\n**...والمزيد**';
    }

    embed.setDescription(downsList || 'لا توجد داونات نشطة');

    await respond({ embeds: [embed] });
}

async function handleUserDowns(interaction, context, respond) {
    const userSelect = new UserSelectMenuBuilder()
        .setCustomId('down_select_user_for_end_down')
        .setPlaceholder(' اختر العضو لإدارة داوناته...');

    const selectRow = new ActionRowBuilder().addComponents(userSelect);

    await respond({
        content: ' **اختر العضو لإدارة الداونات الخاصة به:**',
        components: [selectRow]
    });
}

// Continue with other interaction handlers...
async function handleDownInteractions(interaction, context) {
    const customId = interaction.customId;

    try {
        const isModalTrigger = 
            (interaction.isStringSelectMenu() && (customId === 'down_role_selection' || customId === 'down_select_down_to_modify' || customId === 'down_select_down_to_end')) ||
            (interaction.isModalSubmit()) || 
            (interaction.isUserSelectMenu() && (customId === 'down_show_user_records' || customId === 'down_selected_user' || customId === 'down_select_user_for_end_down'));

        if (!interaction.replied && !interaction.deferred && !isModalTrigger) {
            await interaction.deferReply({ ephemeral: true }).catch(() => {});
        }
    } catch (e) {}

    // Handle user selection for remove role
    if (interaction.isUserSelectMenu() && customId === 'down_selected_user') {
        const selectedUserId = interaction.values[0];
        const selectedUser = await interaction.guild.members.fetch(selectedUserId);

        // Get admin roles that the user has
        const adminRoles = downManager.getAdminRoles();
        const userAdminRoles = selectedUser.roles.cache.filter(role => {
            // Check if role is in admin roles list only
            return adminRoles.includes(role.id);
        });

        if (userAdminRoles.size === 0) {
            const noRolesEmbed = colorManager.createEmbed()
                .setDescription(` **العضو** <@${selectedUserId}> **لا يملك أي رولات إدارية قابلة للسحب!**\n\n` +
                    ` **تحقق من:**\n` +
                    `• هل العضو لديه رولات مُضافة في \`adminroles\`؟\n` +
                    `• هل الرولات غير محمية (ليست رولات بوت أو نيترو)؟`);

            if (interaction.replied || interaction.deferred) {
                await interaction.editReply({ embeds: [noRolesEmbed] });
            } else {
                await interaction.reply({ embeds: [noRolesEmbed], ephemeral: true });
            }
            return;
        }

        // Create role selection menu
        const roleOptions = userAdminRoles.map(role => ({
            label: role.name,
            value: `${selectedUserId}_${role.id}`,
            description: `سحب رول ${role.name} من ${selectedUser.displayName}`
        }));

        const roleSelect = new StringSelectMenuBuilder()
            .setCustomId('down_role_selection')
            .setPlaceholder('اختر رول واحد أو أكثر لسحبه...')
            .setMinValues(1)
            .setMaxValues(roleOptions.length)
            .addOptions(roleOptions);

        const selectRow = new ActionRowBuilder().addComponents(roleSelect);

        const response = {
            content: ` **اختر الرول المراد سحبه من** <@${selectedUserId}>**:**`,
            components: [selectRow],
            ephemeral: true
        };

        if (interaction.replied || interaction.deferred) {
            await interaction.editReply(response);
        } else {
            await interaction.reply(response);
        }
        return;
    }

    if (interaction.isStringSelectMenu() && customId === 'down_role_selection') {
        const selectedValues = interaction.values;
        const userId = selectedValues[0].split('_')[0];
        const roleIds = selectedValues.map(v => v.split('_')[1]);

        // Create modal for duration and reason
        const modal = new ModalBuilder()
            .setCustomId(`down_modal_${userId}_${roleIds.join(',')}`)
            .setTitle('تفاصيل الداون');

        const durationInput = new TextInputBuilder()
            .setCustomId('down_duration')
            .setLabel('المدة (مثل: 7d أو 12h أو نهائي أو شفوي)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('7d, 12h, نهائي, شفوي');

        const reasonInput = new TextInputBuilder()
            .setCustomId('down_reason')
            .setLabel('السبب')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setPlaceholder('اذكر سبب سحب الرول...');

        modal.addComponents(
            new ActionRowBuilder().addComponents(durationInput),
            new ActionRowBuilder().addComponents(reasonInput)
        );

        return await interaction.showModal(modal);
    }

    if (interaction.isStringSelectMenu() && customId === 'down_select_user_for_duration_modify') {
        const selectedUserId = interaction.values[0];
        const activeDownsPath = path.join(__dirname, '..', 'data', 'activeDowns.json');
        const activeDowns = readJson(activeDownsPath, {});

        // Find this user's downs and group by batchId
        const batchMap = new Map();
        for (const [id, data] of Object.entries(activeDowns)) {
            if (data.userId === selectedUserId && data.roleId !== null) {
                const key = data.batchId || id;
                if (!batchMap.has(key)) {
                    batchMap.set(key, []);
                }
                batchMap.get(key).push({ id, ...data });
            }
        }

        const respond = async (data) => {
            if (interaction.deferred || interaction.replied) {
                return await interaction.editReply(data);
            } else {
                return await interaction.reply({ ...data, ephemeral: true });
            }
        };

        if (batchMap.size === 0) {
            await respond({
                content: ` **العضو** <@${selectedUserId}> **ليس لديه أي داونات نشطة حالياً!**`
            });
            return;
        }

        const roleOptions = [];
        for (const [key, items] of batchMap.entries()) {
            const roleNames = [];
            for (const item of items) {
                const role = interaction.guild.roles.cache.get(item.roleId);
                roleNames.push(role ? role.name : `رول ${item.roleId}`);
            }

            const mainItem = items[0];
            roleOptions.push({
                label: `تعديل : ${roleNames.join(' , ').substring(0, 50)}`,
                value: mainItem.id, // We use the first ID, manager will find the batch
                description: `المدة: ${mainItem.duration || 'نهائي'}`,
            });
        }

        const roleSelect = new StringSelectMenuBuilder()
            .setCustomId('down_select_down_to_modify')
            .setPlaceholder('اختر الداون لتعديل مدته...')
            .addOptions(roleOptions.slice(0, 25));

        const selectRow = new ActionRowBuilder().addComponents(roleSelect);

        await respond({
            content: ` **اختر الداون الذي تريد تعديل مدته للعضو** <@${selectedUserId}>:`,
            components: [selectRow]
        });
        return;
    }

    if (interaction.isStringSelectMenu() && customId === 'down_select_down_to_modify') {
        const downId = interaction.values[0];

        const modal = new ModalBuilder()
            .setCustomId(`down_duration_modify_${downId}`)
            .setTitle('تعديل مدة الداون');

        const newDurationInput = new TextInputBuilder()
            .setCustomId('new_duration')
            .setLabel('المدة الجديدة (مثل: 7d أو 12h أو نهائي)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('7d, 12h, 30m, نهائي');

        modal.addComponents(new ActionRowBuilder().addComponents(newDurationInput));

        return await interaction.showModal(modal);
    }

    // Handle user selection for ending a down
    if (interaction.isUserSelectMenu() && customId === 'down_select_user_for_end_down') {
        const selectedUserId = interaction.values[0];
        const member = await interaction.guild.members.fetch(selectedUserId);
        const activeDownsPath = path.join(__dirname, '..', 'data', 'activeDowns.json');
        const activeDowns = readJson(activeDownsPath, {});

        // Find user downs from flat structure
        const userDowns = [];
        for (const [downId, downData] of Object.entries(activeDowns)) {
            if (downData.userId === selectedUserId && downData.guildId === interaction.guild.id && downData.roleId !== null) {
                userDowns.push({ downId, ...downData });
            }
        }

        const respond = async (data) => {
            if (interaction.deferred || interaction.replied) {
                return await interaction.editReply(data);
            } else {
                return await interaction.reply({ ...data, ephemeral: true });
            }
        };

        if (userDowns.length === 0) {
            await respond({
                content: ` **العضو** <@${selectedUserId}> **ليس لديه أي داونات نشطة حالياً لإنهاءها!**`
            });
            return;
        }

        const roleOptions = userDowns.map((downData) => {
            const role = interaction.guild.roles.cache.get(downData.roleId);
            const roleName = role ? role.name : `Role ID: ${downData.roleId}`;
            const endTimeText = downData.endTime ? 
                new Date(downData.endTime).toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' }) : 
                'نهائي';

            return {
                label: `إنهاء داون : ${roleName}`,
                value: downData.id,
                description: `الداون ينتهيء : ${endTimeText}`,
            };
        }).slice(0, 25); // Limit to 25 options

        const roleSelect = new StringSelectMenuBuilder()
            .setCustomId('down_select_down_to_end')
            .setPlaceholder('اختر الداون لإنهاءه...')
            .addOptions(roleOptions);

        const selectRow = new ActionRowBuilder().addComponents(roleSelect);

        await respond({
            content: ` **اختر الداون الذي تريد إنهاءه للعضو** <@${selectedUserId}>:`,
            components: [selectRow]
        });
        return;
    }

    // This code is now handled above in the corrected section

    // Handle modal submission for down
    if (interaction.isModalSubmit() && customId.startsWith('down_modal_')) {
        const parts = customId.split('_');
        const userId = parts[2];
        const roleIdsString = parts[3];
        const roleIds = roleIdsString.split(',');
        const duration = interaction.fields.getTextInputValue('down_duration');
        const reason = interaction.fields.getTextInputValue('down_reason');

        try {
            const isVerbal = duration === 'شفوي' || duration === 'verbal';
            
            if (isVerbal) {
                const result = await downManager.createDown(interaction.guild, client, userId, null, duration, reason, interaction.user.id);
                if (result.success) {
                    const successEmbed = colorManager.createEmbed()
                        .setTitle('✅ تم تسجيل تنبيه شفوي')
                        .setDescription(`تم تسجيل تنبيه شفوي للعضو كما هو مطلوب`)
                        .addFields([
                            { name: ' العضو', value: `<@${userId}>`, inline: true },
                            { name: 'الرول', value: 'شفوي', inline: true },
                            { name: ' المدة', value: result.duration || 'شفوي', inline: true },
                            { name: ' السبب', value: reason, inline: false },
                            { name: ' بواسطة', value: `<@${interaction.user.id}>`, inline: true }
                        ])
                        .setTimestamp();
                    await interaction.reply({ embeds: [successEmbed], ephemeral: true });

                    // Send DM notification for verbal down
                    try {
                        const targetMember = await interaction.guild.members.fetch(userId);
                        const dmEmbed = colorManager.createEmbed()
                            .setTitle('تنبيه شفوي')
                            .setDescription(`لقد تلقيت تنبيهاً شفوياً من قبل الإدارة.`)
                            .addFields([
                                { name: 'النوع', value: 'شفوي', inline: true },
                                { name: 'السبب', value: reason, inline: false },
                                { name: 'بواسطة', value: `<@${interaction.user.id}>`, inline: true },
                                { name: 'التاريخ', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
                            ])
                            .setTimestamp();

                        await targetMember.send({ embeds: [dmEmbed] });
                    } catch (dmError) {
                        console.log(`لا يمكن إرسال رسالة خاصة إلى العضو - قد تكون الرسائل الخاصة مغلقة`);
                    }
                }
            } else {
                const results = [];
                const batchId = Date.now().toString();
                for (const roleId of roleIds) {
                    const res = await downManager.createDown(interaction.guild, client, userId, roleId, duration, reason, interaction.user.id);
                    if (res.success) {
                        // Mark as batch in activeDowns
                        const activeDownsPath = path.join(__dirname, '..', 'data', 'activeDowns.json');
                        const activeDowns = readJson(activeDownsPath, {});
                        if (activeDowns[res.downId]) {
                            activeDowns[res.downId].batchId = batchId;
                            saveJson(activeDownsPath, activeDowns);
                        }
                    }
                    results.push({ roleId, ...res });
                }

                const allSuccess = results.every(r => r.success);
                const successRoles = results.filter(r => r.success).map(r => `<@&${r.roleId}>`);
                const failedRoles = results.filter(r => !r.success);

                const resultEmbed = colorManager.createEmbed()
                    .setTitle(allSuccess ? '✅ تم تطبيق الداون بنجاح' : '⚠️ تم تطبيق الداون جزئياً')
                    .setDescription(`تمت معالجة سحب الرولات للعضو <@${userId}>`)
                    .addFields([
                        { name: 'الرولات التي سُحبت', value: successRoles.length > 0 ? successRoles.join(' , ') : 'لا يوجد', inline: false },
                        { name: ' المدة', value: duration, inline: true },
                        { name: ' السبب', value: reason, inline: false },
                        { name: ' بواسطة', value: `<@${interaction.user.id}>`, inline: true }
                    ]);

                if (failedRoles.length > 0) {
                    resultEmbed.addFields({
                        name: '❌ فشل في سحب رولات:',
                        value: failedRoles.map(r => `<@&${r.roleId}>: ${r.error}`).join('\n'),
                        inline: false
                    });
                }

                await interaction.reply({ embeds: [resultEmbed], ephemeral: true });

                // Send DM notification for normal down
                try {
                    const targetMember = await interaction.guild.members.fetch(userId);
                    const dmEmbed = colorManager.createEmbed()
                        .setTitle('Role(s) Down')
                        .setDescription(`تم اعطائك داون من قبل الإدارة.`)
                        .addFields([
                            { name: ' الرولات المسحوبة', value: successRoles.join(' , ') || 'لا يوجد', inline: false },
                            { name: ' سحب الرول', value: `<@${interaction.user.id}>`, inline: true },
                            { name: ' المدة', value: duration || 'نهائي', inline: true },
                            { name: ' السبب', value: reason, inline: false }
                        ])
                        .setTimestamp();

                    await targetMember.send({ embeds: [dmEmbed] });
                } catch (dmError) {
                    console.log(`لا يمكن إرسال رسالة خاصة إلى العضو - قد تكون الرسائل الخاصة مغلقة`);
                }
            }
        } catch (error) {
            console.error('Error processing down modal:', error);
            await interaction.reply({ content: '❌ حدث خطأ غير متوقع أثناء معالجة الداون.', ephemeral: true });
        }
        return;
    }

    // Handle duration modification modal submission
    if (interaction.isModalSubmit() && customId.startsWith('down_duration_modify_')) {
        const downId = customId.replace('down_duration_modify_', '');
        const newDuration = interaction.fields.getTextInputValue('new_duration');

        // Get down data to extract userId and roleId
        const activeDownsPath = path.join(__dirname, '..', 'data', 'activeDowns.json');
        const activeDowns = readJson(activeDownsPath, {});
        const downData = activeDowns[downId];

        if (!downData) {
            await interaction.reply({
                content: ' **الداون غير موجود أو تم حذفه!**',
                ephemeral: true
            });
            return;
        }

        const userId = downData.userId;
        const roleId = downData.roleId;

        try {
            const member = await interaction.guild.members.fetch(userId);
            const activeDownsPath = path.join(__dirname, '..', 'data', 'activeDowns.json');
            const activeDowns = readJson(activeDownsPath, {});
            const downData = activeDowns[downId];

            if (!downData) {
                await interaction.reply({ content: ' **الداون غير موجود!**', ephemeral: true });
                return;
            }

            // Find all related roles in batch
            const batchRoles = [];
            if (downData.batchId) {
                for (const d of Object.values(activeDowns)) {
                    if (d.batchId === downData.batchId && d.userId === userId && d.roleId) {
                        const r = await interaction.guild.roles.fetch(d.roleId).catch(() => null);
                        if (r) batchRoles.push(r.name);
                    }
                }
            } else if (downData.roleId) {
                const r = await interaction.guild.roles.fetch(downData.roleId).catch(() => null);
                if (r) batchRoles.push(r.name);
            }

            // Modify duration using downManager
            const result = await downManager.modifyDownDuration(
                interaction.guild,
                context.client,
                downId,
                newDuration,
                interaction.user
            );

            if (result.success) {
                const successEmbed = colorManager.createEmbed()
                    .setTitle('✅ تم تعديل مدة الداون')
                    .addFields([
                        { name: ' العضو', value: `<@${userId}>`, inline: true },
                        { name: ' الرولات', value: batchRoles.join(' , ') || 'شفوي', inline: false },
                        { name: ' المدة الجديدة', value: result.newDuration || 'نهائي', inline: true },
                        { name: ' تم التعديل بواسطة', value: `<@${interaction.user.id}>`, inline: true }
                    ])
                    .setTimestamp();

                await interaction.reply({ embeds: [successEmbed], ephemeral: true });

                // Notify the user
                try {
                    const notifyEmbed = colorManager.createEmbed()
                        .setTitle('تعديل مدة الداون')
                        .setDescription(`تم تعديل مدة الداون الخاص بك للرولات: **${batchRoles.join(' , ')}**.`)
                        .addFields([
                            { name: ' المدة الجديدة', value: result.newDuration || 'نهائي', inline: true },
                            { name: ' تم التعديل بواسطة', value: `<@${interaction.user.id}>`, inline: true }
                        ])
                        .setTimestamp();

                    await member.send({ embeds: [notifyEmbed] });
                } catch (dmError) {
                    console.log(`لا يمكن إرسال رسالة للمستخدم ${userId}`);
                }
            } else {
                await interaction.reply({ content: ` **فشل في تعديل المدة:** ${result.error}`, ephemeral: true });
            }
        } catch (error) {
            console.error('خطأ في تعديل مدة الداون:', error);
            await interaction.reply({
                content: ' **حدث خطأ أثناء تعديل المدة!**',
                ephemeral: true
            });
        }
        return;
    }

    if (interaction.isStringSelectMenu() && customId === 'down_select_down_to_end') {
        const downId = interaction.values[0];

        const modal = new ModalBuilder()
            .setCustomId(`down_end_${downId}`)
            .setTitle('إنهاء الداون');

        const endReasonInput = new TextInputBuilder()
            .setCustomId('end_reason')
            .setLabel('سبب الإنهاء')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setPlaceholder('اذكر سبب إنهاء الداون...');

        modal.addComponents(new ActionRowBuilder().addComponents(endReasonInput));

        return await interaction.showModal(modal);
    }

    // Handle down end modal submission
    if (interaction.isModalSubmit() && customId.startsWith('down_end_')) {
        const downId = customId.replace('down_end_', '');
        const endReason = interaction.fields.getTextInputValue('end_reason');

        // Get down data to extract userId and roleId
        const activeDownsPath = path.join(__dirname, '..', 'data', 'activeDowns.json');
        const activeDowns = readJson(activeDownsPath, {});
        const downData = activeDowns[downId];

        if (!downData) {
            await interaction.reply({
                content: ` **الداون غير موجود أو تم حذفه!**`,
                ephemeral: true
            });
            return;
        }

        const userId = downData.userId;
        const roleId = downData.roleId;

        try {
            const member = await interaction.guild.members.fetch(userId);
            const role = await interaction.guild.roles.fetch(roleId);

            if (!member || !role) {
                await interaction.reply({
                    content: ' **العضو أو الرول غير موجود!**',
                    ephemeral: true
                });
                return;
            }

            // End the down using downManager
            const result = await downManager.endDown(interaction.guild, context.client, downId, endReason);

            if (result.success) {
                const successEmbed = colorManager.createEmbed()
                    .setTitle('Down Ended Successfully')
                    .addFields([
                        { name: ' العضو', value: `<@${userId}>`, inline: true },
                        { name: ' الرول', value: `<@&${roleId}>`, inline: true },
                        { name: ' سبب الإنهاء', value: endReason, inline: false },
                        { name: ' تم الإنهاء بواسطة', value: `<@${interaction.user.id}>`, inline: true }
                    ])
                    .setTimestamp();

                await interaction.reply({ embeds: [successEmbed], ephemeral: true });

                // Notify the user
                try {
                    const notifyEmbed = colorManager.createEmbed()
                        .setTitle('Down Ended')
                        .setDescription(`تم إنهاء الداون الخاص بك وإعادة الرول **${role.name}**.`)
                        .addFields([
                            { name: ' الرول المُعاد', value: role.name, inline: true },
                            { name: ' تم الإنهاء بواسطة', value: interaction.user.username, inline: true },
                            { name: ' سبب الإنهاء', value: endReason, inline: false }
                        ])
                        .setTimestamp();

                    await member.send({ embeds: [notifyEmbed] });
                } catch (dmError) {
                    console.log(`لا يمكن إرسال رسالة للمستخدم ${userId}: ${dmError.message}`);
                }

            } else {
                await interaction.reply({
                    content: ` **فشل في إنهاء الداون:** ${result.error}`,
                    ephemeral: true
                });
            }

        } catch (error) {
            console.error('خطأ في إنهاء الداون:', error);
            await interaction.reply({
                content: ' **حدث خطأ أثناء إنهاء الداون!**',
                ephemeral: true
            });
        }
        return;
    }

    // Handle modal submission for changing permissions
    if (interaction.isModalSubmit() && customId.startsWith('down_edit_permission_')) {
        const permissionType = customId.split('_')[3]; // Get 'owners', 'roles', or 'responsibility'
        const settingsPath = path.join(__dirname, '..', 'data', 'downSettings.json');
        const settings = readJson(settingsPath, {});

        settings.allowedUsers.type = permissionType;
        settings.allowedUsers.targets = []; // Clear existing targets

        if (permissionType === 'owners') {
            settings.allowedUsers.targets = context.BOT_OWNERS;
            saveJson(settingsPath, settings);
            await interaction.reply({
                content: ' **تم تغيير صلاحيات المعتمدين إلى "المالكين فقط".**',
                ephemeral: true
            });
        } else if (permissionType === 'roles') {
            const roleSelect = new RoleSelectMenuBuilder()
                .setCustomId('down_edit_select_roles')
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
                await interaction.reply({
                    content: '⚠️ **لا توجد مسؤوليات معرّفة! يرجى إضافتها أولاً.**',
                    ephemeral: true
                });
                return;
            }

            const respOptions = Object.keys(responsibilities).slice(0, 25).map(name => ({
                label: name,
                value: name,
                description: `السماح للمسؤولين عن ${name}`
            }));

            const respSelect = new StringSelectMenuBuilder()
                .setCustomId('down_edit_select_responsibilities')
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
    if (interaction.isRoleSelectMenu() && customId === 'down_edit_select_roles') {
        const settingsPath = path.join(__dirname, '..', 'data', 'downSettings.json');
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
    if (interaction.isStringSelectMenu() && customId === 'down_edit_select_responsibilities') {
        const settingsPath = path.join(__dirname, '..', 'data', 'downSettings.json');
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
    if (interaction.isChannelSelectMenu() && customId === 'down_edit_log_channel_select') {
        const settingsPath = path.join(__dirname, '..', 'data', 'downSettings.json');
        const settings = readJson(settingsPath, {});
        settings.logChannel = interaction.values[0];
        saveJson(settingsPath, settings);

        await interaction.update({
            content: ' **تم تغيير روم السجلات بنجاح.**',
            components: []
        });
        return;
    }

    // Handle menu channel selection for editing
    if (interaction.isChannelSelectMenu() && customId === 'down_edit_menu_channel_select') {
        const settingsPath = path.join(__dirname, '..', 'data', 'downSettings.json');
        const settings = readJson(settingsPath, {});
        settings.menuChannel = interaction.values[0];
        saveJson(settingsPath, settings);

        // Re-send the menu to the new channel
        const success = await createPermanentMenu(context.client, settings.menuChannel);
        const messageContent = success ?
            ` **تم تغيير روم المنيو بنجاح و إرسال المنيو إلى** <#${settings.menuChannel}>` :
            ` **تم تغيير روم المنيو بنجاح، ولكن فشل إرسال المنيو إلى** <#${settings.menuChannel}>`;

        await interaction.update({
            content: messageContent,
            components: []
        });
        return;
    }

    // Handle owner settings menu interactions
    if (customId === 'down_owner_settings') {
        const selectedValue = interaction.values[0];
        switch (selectedValue) {
            case 'resend_menu':
                const settingsPath = path.join(__dirname, '..', 'data', 'downSettings.json');
                const settings = readJson(settingsPath, {});
                if (!settings.menuChannel) {
                    await interaction.reply({
                        content: ' **لم يتم تحديد روم المنيو! يرجى إعداد النظام أولاً.**',
                        ephemeral: true
                    });
                    return;
                }
                const success = await createPermanentMenu(context.client, settings.menuChannel);
                await interaction.reply({
                    content: success ? ` **تم إعادة إرسال المنيو إلى** <#${settings.menuChannel}>` : ` **فشل في إعادة إرسال المنيو.**`,
                    ephemeral: true
                });
                break;
            case 'edit_settings':
                await handleEditSettings(interaction, context);
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

    // Handle specific edit setting interactions
    if (customId === 'down_edit_setting') {
        const selectedValue = interaction.values[0];
        switch (selectedValue) {
            case 'edit_permissions':
                await handleEditPermissions(interaction, context);
                break;
            case 'edit_log_channel':
                await handleEditLogChannel(interaction, context);
                break;
            case 'edit_menu_channel':
                await handleEditMenuChannel(interaction, context);
                break;
        }
        return;
    }

    // Handle confirmation for system reset
    if (interaction.isButton()) {
        if (interaction.customId === 'down_confirm_reset') {
            try {
                // Clear all data
                saveJson(path.join(__dirname, '..', 'data', 'downSettings.json'), {});
                saveJson(path.join(__dirname, '..', 'data', 'activeDowns.json'), {});
                saveJson(path.join(__dirname, '..', 'data', 'downHistory.json'), []);
                // Optionally, clear responsibilities if needed, but that might be a separate command
                // saveJson(path.join(__dirname, '..', 'data', 'responsibilities.json'), {});

                const resetEmbed = colorManager.createEmbed()
                    .setTitle('System Reset Complete')
                    .setDescription('تم حذف جميع إعدادات وبيانات نظام الداون بنجاح.')
                    .addFields([
                        { name: 'البيانات المحذوفة', value: '• الإعدادات\n• الداونات النشطة\n• سجل الداونات', inline: false }
                    ])
                    .setTimestamp();

                await interaction.update({
                    embeds: [resetEmbed],
                    components: []
                });

                // Log the reset
                await downManager.logDownAction(interaction.guild, {
                    type: 'SYSTEM_RESET',
                    moderator: interaction.user,
                    reason: 'إعادة تعيين كاملة للنظام'
                });

            } catch (error) {
                console.error('خطأ في إعادة تعيين النظام:', error);
                await interaction.update({
                    content: ' **حدث خطأ أثناء إعادة تعيين النظام!**',
                    embeds: [],
                    components: []
                });
            }
            return;
        }

        if (interaction.customId === 'down_cancel_reset') {
            await interaction.update({
                content: ' **تم إلغاء إعادة تعيين النظام.**',
                embeds: [],
                components: []
            });
            return;
        }
    }

    // Handle user selection for showing records
    if (interaction.isUserSelectMenu() && customId === 'down_show_user_records') {
        try {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferReply({ ephemeral: true }).catch(() => {});
            }
        } catch (e) {}

        const selectedUserId = interaction.values[0];
        const downManager = require('../utils/downManager');

        // احصل على الداونات النشطة والسجلات من downManager
        const activeDowns = downManager.getUserDowns(selectedUserId);
        // Filter out verbal downs from active downs for modification/ending purposes
        const nonVerbalActiveDowns = activeDowns.filter(d => d.roleId !== null);
        const allLogs = downManager.getUserDownHistory(selectedUserId);
        const userHistory = [];

        // تحويل السجلات إلى تنسيق يمكن عرضه
        allLogs.forEach(log => {
            const isVerbalAction = log.type === 'DOWN_VERBAL';
            const isVerbalData = log.data.roleId === null || log.data.duration === 'شفوي' || log.data.duration === 'verbal';
            const isVerbal = isVerbalAction || isVerbalData;
            
            if (log.type === 'DOWN_APPLIED' || log.type === 'DOWN_VERBAL') {
                userHistory.push({
                    userId: log.data.targetUserId,
                    roleId: log.data.roleId,
                    roleName: isVerbal ? 'تنبيه شفوي' : `رول (ID: ${log.data.roleId})`,
                    duration: isVerbal ? 'بدون مدة' : (log.data.duration || 'نهائي'),
                    reason: log.data.reason,
                    moderatorId: log.data.byUserId,
                    timestamp: log.timestamp,
                    action: isVerbal ? 'تم تسجيل تنبيه شفوي' : 'تم سحب الرول'
                });
            } else if (log.type === 'DOWN_ENDED' && !isVerbal) {
                userHistory.push({
                    userId: log.data.targetUserId,
                    roleId: log.data.roleId,
                    roleName: `رول (ID: ${log.data.roleId})`,
                    duration: log.data.duration || 'نهائي',
                    reason: log.data.reason || log.data.originalReason,
                    moderatorId: log.data.byUserId,
                    timestamp: log.timestamp,
                    action: 'تم إنهاء الداون'
                });
            }
        });

        // إضافة الداونات النشطة الحالية
        for (const activeDown of nonVerbalActiveDowns) {
            try {
                const role = await interaction.guild.roles.fetch(activeDown.roleId);
                userHistory.unshift({ // إضافة في المقدمة لعرضها أولاً
                    userId: activeDown.userId,
                    roleId: activeDown.roleId,
                    roleName: role ? role.name : `رول محذوف (ID: ${activeDown.roleId})`,
                    duration: activeDown.duration || 'نهائي',
                    reason: activeDown.reason,
                    moderatorId: activeDown.byUserId,
                    timestamp: activeDown.startTime,
                    endTime: activeDown.endTime,
                    action: '🔴 داون نشط حالياً',
                    isActive: true
                });
            } catch (error) {
                console.error('خطأ في جلب معلومات الرول النشط:', error);
            }
        }

        if (userHistory.length === 0) {
            const noRecordsEmbed = colorManager.createEmbed()
                .setDescription(` **العضو** <@${selectedUserId}> **ليس لديه أي سجلات داون.**`);

            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ embeds: [noRecordsEmbed] });
            } else {
                await interaction.reply({ embeds: [noRecordsEmbed], ephemeral: true });
            }
            return;
        }

        // Show records with pagination
        const recordsPerPage = 5;
        let page = 0;
        const totalPages = Math.ceil(userHistory.length / recordsPerPage);

        function createRecordsEmbed(page) {
            const start = page * recordsPerPage;
            const end = start + recordsPerPage;
            const pageRecords = userHistory.slice(start, end);

            const embed = colorManager.createEmbed()
                .setTitle(`Down Records - <@${selectedUserId}>`)
                .setDescription(`**الصفحة ${page + 1} من ${totalPages}** • **إجمالي السجلات: ${userHistory.length}**`)
                .setTimestamp();

            pageRecords.forEach((record, index) => {
                const globalIndex = start + index + 1;
                embed.addFields([
                    {
                        name: ` سجل رقم ${globalIndex}`,
                        value: `**الإجراء:** ${record.action || 'غير محدد'}\n` +
                               `**الرول:** ${record.roleName || 'غير محدد'}\n` +
                               `**المدة:** ${record.duration || 'نهائي'}\n` +
                               `**السبب:** ${record.reason || 'غير محدد'}\n` +
                               `**بواسطة:** <@${record.moderatorId}>\n` +
                               `**التاريخ:** <t:${Math.floor(record.timestamp / 1000)}:F>` +
                               (record.isActive && record.endTime ? `\n** ينتهي في:** <t:${Math.floor(record.endTime / 1000)}:R>` : ''),
                        inline: false
                    }
                ]);
            });

            return embed;
        }

        const recordsEmbed = createRecordsEmbed(page);
        const components = [];

        if (totalPages > 1) {
            const navigationRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`records_prev_${selectedUserId}_${page}`)
                    .setLabel(' السابق')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId(`records_next_${selectedUserId}_${page}`)
                    .setLabel('التالي ')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page === totalPages - 1)
            );
            components.push(navigationRow);
        }

        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ embeds: [recordsEmbed], components });
        } else {
            await interaction.reply({ embeds: [recordsEmbed], components, ephemeral: true });
        }
        return;
    }

    // Handle pagination for user records
    if (interaction.isButton() && (customId.startsWith('records_prev_') || customId.startsWith('records_next_'))) {
        const [action, direction, userId, currentPage] = customId.split('_');
        const page = direction === 'prev' ? parseInt(currentPage) - 1 : parseInt(currentPage) + 1;

        const downManager = require('../utils/downManager');

        // احصل على السجلات من downManager
        const allLogs = downManager.getUserDownHistory(userId);
        const userHistory = [];

        // تحويل السجلات إلى تنسيق يمكن عرضه
        allLogs.forEach(log => {
            const isVerbalAction = log.type === 'DOWN_VERBAL';
            const isVerbalData = log.data.roleId === null || log.data.duration === 'شفوي' || log.data.duration === 'verbal';
            const isVerbal = isVerbalAction || isVerbalData;
            
            if (log.type === 'DOWN_APPLIED' || log.type === 'DOWN_VERBAL') {
                userHistory.push({
                    userId: log.data.targetUserId,
                    roleId: log.data.roleId,
                    roleName: isVerbal ? 'تنبيه شفوي' : `رول (ID: ${log.data.roleId})`,
                    duration: isVerbal ? 'بدون مدة' : (log.data.duration || 'نهائي'),
                    reason: log.data.reason,
                    moderatorId: log.data.byUserId,
                    timestamp: log.timestamp,
                    action: isVerbal ? 'تم تسجيل تنبيه شفوي' : 'تم سحب الرول'
                });
            } else if (log.type === 'DOWN_ENDED' && !isVerbal) {
                userHistory.push({
                    userId: log.data.targetUserId,
                    roleId: log.data.roleId,
                    roleName: `رول (ID: ${log.data.roleId})`,
                    duration: log.data.duration || 'نهائي',
                    reason: log.data.reason || log.data.originalReason,
                    moderatorId: log.data.byUserId,
                    timestamp: log.timestamp,
                    action: 'تم إنهاء الداون'
                });
            }
        });

        const recordsPerPage = 5;
        const totalPages = Math.ceil(userHistory.length / recordsPerPage);

        function createRecordsEmbed(page) {
            const start = page * recordsPerPage;
            const end = start + recordsPerPage;
            const pageRecords = userHistory.slice(start, end);

            const embed = colorManager.createEmbed()
                .setTitle(`Down Records - <@${userId}>`)
                .setDescription(`**الصفحة ${page + 1} من ${totalPages}** • **إجمالي السجلات: ${userHistory.length}**`)
                .setTimestamp();

            pageRecords.forEach((record, index) => {
                const globalIndex = start + index + 1;
                embed.addFields([
                    {
                        name: ` سجل رقم ${globalIndex}`,
                        value: `**الإجراء:** ${record.action || 'غير محدد'}\n` +
                               `**الرول:** ${record.roleName || 'غير محدد'}\n` +
                               `**المدة:** ${record.duration || 'نهائي'}\n` +
                               `**السبب:** ${record.reason || 'غير محدد'}\n` +
                               `**بواسطة:** <@${record.moderatorId}>\n` +
                               `**التاريخ:** <t:${Math.floor(record.timestamp / 1000)}:F>` +
                               (record.isActive && record.endTime ? `\n**ينتهي في:** <t:${Math.floor(record.endTime / 1000)}:R>` : ''),
                        inline: false
                    }
                ]);
            });

            return embed;
        }

        const recordsEmbed = createRecordsEmbed(page);
        const components = [];

        if (totalPages > 1) {
            const navigationRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`records_prev_${userId}_${page}`)
                    .setLabel(' السابق')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId(`records_next_${userId}_${page}`)
                    .setLabel('التالي ')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page === totalPages - 1)
            );
            components.push(navigationRow);
        }

        await interaction.update({ embeds: [recordsEmbed], components });
        return;
    }

    // Handle permission type selection for editing
    if (interaction.isStringSelectMenu() && customId === 'down_edit_permission_type') {
        const selectedType = interaction.values[0];
        const settingsPath = path.join(__dirname, '..', 'data', 'downSettings.json');
        const settings = readJson(settingsPath, {});

        settings.allowedUsers.type = selectedType;
        settings.allowedUsers.targets = []; // Clear existing targets

        if (selectedType === 'owners') {
            settings.allowedUsers.targets = context.BOT_OWNERS;
            saveJson(settingsPath, settings);
            await interaction.update({
                content: ' **تم تغيير صلاحيات المعتمدين إلى "المالكين فقط".**',
                components: []
            });
        } else if (selectedType === 'roles') {
            const roleSelect = new RoleSelectMenuBuilder()
                .setCustomId('down_edit_select_roles')
                .setPlaceholder(' اختر الرولات المعتمدة...')
                .setMaxValues(10);

            const roleRow = new ActionRowBuilder().addComponents(roleSelect);

            await interaction.update({
                content: ' **اختر الرولات المعتمدة لاستخدام النظام:**',
                components: [roleRow]
            });
        } else if (selectedType === 'responsibility') {
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
                .setCustomId('down_edit_select_responsibilities')
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
}

// New functions for handling settings edits
async function handleEditSettings(interaction, context) {
    const settingsPath = path.join(__dirname, '..', 'data', 'downSettings.json');
    const settings = readJson(settingsPath, {});

    const editEmbed = colorManager.createEmbed()
        .setTitle('Edit Settings')
        .setDescription('اختر ما تريد تعديله من إعدادات النظام')
        .addFields([
            { name: ' المعتمدين الحاليين', value: `${getPermissionTypeText(settings.allowedUsers?.type)} (${settings.allowedUsers?.targets?.length || 0})`, inline: true },
            { name: ' روم السجلات', value: settings.logChannel ? `<#${settings.logChannel}>` : 'غير محدد', inline: true },
            { name: ' روم المنيو', value: settings.menuChannel ? `<#${settings.menuChannel}>` : 'غير محدد', inline: true }
        ]);

    const editSelect = new StringSelectMenuBuilder()
        .setCustomId('down_edit_setting')
        .setPlaceholder('🔧 اختر الإعداد المراد تعديله...')
        .addOptions([
            {
                label: 'تغيير المعتمدين',
                value: 'edit_permissions',
                description: 'تعديل من يمكنه استخدام نظام الداون'
            },
            {
                label: 'تغيير قناة السجلات',
                value: 'edit_log_channel',
                description: 'تحديد قناة جديدة للسجلات',
            },
            {
                label: 'تغيير قناة المنيو',
                value: 'edit_menu_channel',
                description: 'تحديد قناة جديدة للمنيو التفاعلي',
            }
        ]);

    const editRow = new ActionRowBuilder().addComponents(editSelect);

    const replyMethod = (interaction.deferred || interaction.replied) ? 'editReply' : 'update';
    await interaction[replyMethod]({
        embeds: [editEmbed],
        components: [editRow],
        content: null
    });
}

async function handleEditPermissions(interaction, context) {
    const permissionSelect = new StringSelectMenuBuilder()
        .setCustomId('down_edit_permission_type')
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
        .setCustomId('down_edit_log_channel_select')
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
        .setCustomId('down_edit_menu_channel_select')
        .setPlaceholder(' اختر قناة المنيو الجديدة...')
        .setChannelTypes([ChannelType.GuildText]);

    const channelRow = new ActionRowBuilder().addComponents(channelSelect);

    await interaction.update({
        content: ' **اختر روم المنيو الجديدة:**',
        components: [channelRow]
    });
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
            { name: 'سيحذف:', value: '• جميع الإعدادات\n• الداونات النشطة\n• السجلات', inline: false },
            { name: 'تحذير:', value: 'لا يوجد باكب', inline: false }
        ])
;

    const confirmButton = new ButtonBuilder()
        .setCustomId('down_confirm_reset')
        .setLabel(' تأكيد الإعادة')
        .setStyle(ButtonStyle.Danger);

    const cancelButton = new ButtonBuilder()
        .setCustomId('down_cancel_reset')
        .setLabel(' إلغاء')
        .setStyle(ButtonStyle.Secondary);

    const buttonRow = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

    await interaction.update({
        embeds: [confirmEmbed],
        components: [buttonRow]
    });
}








module.exports = { name, execute, handleInteraction };
