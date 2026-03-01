const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionsBitField } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { createPaginatedResponsibilityArray, handlePaginationInteraction } = require('../utils/responsibilityPagination.js');

const name = 'cooldown';

// مسارات الملفات
const cooldownsPath = path.join(__dirname, '..', 'data', 'cooldowns.json');

// User cooldowns للتتبع - سيتم حفظها في JSON
const userCooldowns = new Map();

function loadCooldowns() {
    try {
        if (fs.existsSync(cooldownsPath)) {
            const data = fs.readFileSync(cooldownsPath, 'utf8');
            const parsed = JSON.parse(data);

            // التأكد من وجود الهيكل المطلوب
            if (!parsed.responsibilities) parsed.responsibilities = {};
            if (!parsed.userCooldowns) parsed.userCooldowns = {};
            if (!parsed.default) parsed.default = 60000;
            if (!parsed.bypass) {
                parsed.bypass = {
                    users: [],
                    roles: [],
                    responsibilities: []
                };
            }

            console.log('📖 تم تحميل البيانات:', JSON.stringify(parsed, null, 2));
            return parsed;
        }
        console.log('📂 لم يوجد ملف، إنشاء بيانات افتراضية');
        return { default: 60000, responsibilities: {}, userCooldowns: {}, bypass: { users: [], roles: [], responsibilities: [] } };
    } catch (error) {
        console.error('خطأ في قراءة cooldowns:', error);
        return { default: 60000, responsibilities: {}, userCooldowns: {} };
    }
}

function saveCooldowns(cooldownData) {
    try {
        // التأكد من وجود المجلد
        const dir = path.dirname(cooldownsPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // حفظ البيانات مع تسجيل تفصيلي
        fs.writeFileSync(cooldownsPath, JSON.stringify(cooldownData, null, 2), 'utf8');
        console.log('✅ تم حفظ إعدادات الكولداون في JSON');
        console.log('📄 محتوى الملف:', JSON.stringify(cooldownData, null, 2));
        return true;
    } catch (error) {
        console.error('خطأ في حفظ cooldowns:', error);
        return false;
    }
}

// دالة لحفظ الكولداونات المؤقتة
function saveUserCooldowns() {
    const cooldowns = loadCooldowns();
    const userCooldownsObj = {};

    // تحويل Map إلى object للحفظ
    for (const [key, value] of userCooldowns.entries()) {
        userCooldownsObj[key] = value;
    }

    cooldowns.userCooldowns = userCooldownsObj;
    saveCooldowns(cooldowns);
}

// دالة لتحميل الكولداونات المؤقتة
function loadUserCooldowns() {
    const cooldowns = loadCooldowns();
    if (cooldowns.userCooldowns) {
        userCooldowns.clear();
        // تحويل object إلى Map
        for (const [key, value] of Object.entries(cooldowns.userCooldowns)) {
            // فقط إذا لم تنته صلاحية الكولداون
            if (Date.now() < value + 86400000) { // 24 ساعة كحد أقصى
                userCooldowns.set(key, value);
            }
        }
    }
}

function checkCooldown(interaction, responsibilityName) {
    try {
        if (!interaction || !interaction.user || !interaction.guild) {
            console.log('تفاعل غير صالح في checkCooldown');
            return 0;
        }

        const userId = interaction.user.id;
        const guildId = interaction.guild.id;
        const cooldowns = loadCooldowns();
        const bypass = cooldowns.bypass || { users: [], roles: [], responsibilities: [] };

        // Check for bypass
        if (bypass.responsibilities.includes(responsibilityName)) return 0;
        if (bypass.users.includes(userId)) return 0;
        if (interaction.member && interaction.member.roles.cache.some(role => bypass.roles.includes(role.id))) return 0;

        const key = `${userId}_${responsibilityName}`;
        const now = Date.now();

        // Safe access to prevent undefined errors
        const responsibilities = cooldowns.responsibilities || {};
        const cooldownTime = responsibilities[responsibilityName] || cooldowns.default || 60000;

        if (userCooldowns.has(key)) {
            const lastUsed = userCooldowns.get(key);
            const timeLeft = (lastUsed + cooldownTime) - now;
            if (timeLeft > 0) {
                return timeLeft;
            }
        }
        return 0;
    } catch (error) {
        console.error('Error in checkCooldown:', error);
        return 0; // Return 0 to indicate no cooldown if an error occurs
    }
}


function startCooldown(userId, responsibilityName) {
    const key = `${userId}_${responsibilityName}`;
    userCooldowns.set(key, Date.now());
    // حفظ فوري للكولداونات المؤقتة
    saveUserCooldowns();
}

async function execute(message, args, { responsibilities, client, saveData, BOT_OWNERS, colorManager }) {
    // تحميل الكولداونات المؤقتة من JSON
    loadUserCooldowns();

    const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
    if (!isOwner) {
        await message.react('❌');
        return;
    }

    // التأكد من وجود colorManager
    const actualColorManager = colorManager || require('../utils/colorManager');

    // إنشاء الإيمبد الديناميكي
    function createMainEmbed() {
        const cooldowns = loadCooldowns();
        const embed = actualColorManager.createEmbed()
            .setTitle('إعدادات الـ Cooldown')
            .setDescription('اختر ما تريد فعله مع إعدادات الـ cooldown')
            .addFields([
                { name: '**الـ Cooldown الافتراضي**', value: `**${(cooldowns.default || 60000) / 1000} ثانية**`, inline: true },
                { name: '**عدد المسؤوليات المخصصة**', value: `**${Object.keys(cooldowns.responsibilities || {}).length}**`, inline: true }
            ])
            .setThumbnail('https://cdn.discordapp.com/attachments/1393840634149736508/1398089589574602852/download-removebg-preview.png?ex=688417e5&is=6882c665&hm=eef26c389f42a3a391494f38bbac2d18530ff938320f130d288c3b1501104ebe&');

        return embed;
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('cooldown_set_default')
            .setLabel('Set main')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('cooldown_set_responsibility')
            .setLabel('Responsibilities')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('cooldown_view')
            .setLabel('Settings')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('cooldown_bypass')
            .setLabel('Bypass Mng')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('cooldown_reset')
            .setLabel(' Reset')
            .setStyle(ButtonStyle.Secondary)
    );

    const sentMessage = await message.channel.send({ embeds: [createMainEmbed()], components: [row] });

    // Create collector to update embed when needed
    const filter = i => i.user.id === message.author.id && i.message.id === sentMessage.id;
    const collector = message.channel.createMessageComponentCollector({ filter, time: 300000 });

    // لا نحتاج تحديث تلقائي - سيتم التحديث فقط عند الحاجة
    collector.on('collect', async interaction => {
        // تم إزالة التحديث التلقائي لتجنب الرجوع السريع للقائمة الرئيسية
    });

    collector.on('end', () => {
        const disabledRow = new ActionRowBuilder().addComponents(
            row.components.map(button => ButtonBuilder.from(button).setDisabled(true))
        );
        sentMessage.edit({ components: [disabledRow] }).catch(console.error);
    });
}

async function handleInteraction(interaction, context) {
    const { client, responsibilities, colorManager } = context;
    const { customId } = interaction; // Destructure customId here
    try {
        // تحميل الكولداونات المؤقتة من JSON لضمان بيانات حديثة
        loadUserCooldowns();
        // التأكد من وجود colorManager
        const actualColorManager = colorManager || require('../utils/colorManager');

        // إنشاء دالة الإيمبد الديناميكي
        function createMainEmbed() {
            const cooldowns = loadCooldowns();
            const embed = actualColorManager.createEmbed()
                .setTitle('إعدادات الـ Cooldown')
                .setDescription('اختر ما تريد فعله مع إعدادات الـ cooldown')
                .addFields([
                    { name: '**الـ Cooldown الافتراضي**', value: `**${(cooldowns.default || 60000) / 1000} ثانية**`, inline: true },
                    { name: '**عدد المسؤوليات المخصصة**', value: `**${Object.keys(cooldowns.responsibilities || {}).length}**`, inline: true }
                ])
                .setThumbnail('https://cdn.discordapp.com/attachments/1393840634149736508/1398089589574602852/download-removebg-preview.png?ex=688417e5&is=6882c665&hm=eef26c389f42a3a391494f38bbac2d18530ff938320f130d288c3b1501104ebe&');

            return embed;
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('cooldown_set_default')
                .setLabel('Set main')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('cooldown_set_responsibility')
                .setLabel('responsibilities')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('cooldown_view')
                .setLabel('Settings')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
            .setCustomId('cooldown_bypass')
            .setLabel('Bypass Mng')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
                .setCustomId('cooldown_reset')
                .setLabel('reset')
                .setStyle(ButtonStyle.Secondary)
        );

    if (interaction.customId === 'cooldown_back_to_main') {
        await interaction.update({ embeds: [createMainEmbed()], components: [row] });
        return;
    }

    if (interaction.customId === 'cooldown_bypass') {
        const config = loadCooldowns();
        const bypass = config.bypass || { users: [], roles: [], responsibilities: [] };
        
        const bypassEmbed = actualColorManager.createEmbed()
            .setTitle('إدارة تجاوز الكولداون')
            .setDescription('اختر نوع التجاوز الذي تريد إدارته.')
            .addFields([
                { name: 'الأعضاء', value: bypass.users.length > 0 ? bypass.users.map(id => `<@${id}>`).join(', ') : 'لا يوجد', inline: false },
                { name: 'الرولات', value: bypass.roles.length > 0 ? bypass.roles.map(id => `<@&${id}>`).join(', ') : 'لا يوجد', inline: false },
                { name: 'المسؤوليات', value: bypass.responsibilities.length > 0 ? bypass.responsibilities.join(', ') : 'لا يوجد', inline: false }
            ]);

        const bypassButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('cooldown_bypass_users').setLabel('الأعضاء').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('cooldown_bypass_roles').setLabel('الرولات').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('cooldown_bypass_resps').setLabel('المسؤوليات').setStyle(ButtonStyle.Secondary)
        );

        const backButton = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('cooldown_back_to_main').setLabel('➡️ العودة').setStyle(ButtonStyle.Secondary));

        await interaction.update({ embeds: [bypassEmbed], components: [bypassButtons, backButton] });
        
        setTimeout(async () => {
            try {
                await interaction.message.edit({ embeds: [bypassEmbed], components: [bypassButtons, backButton] });
            } catch (error) {
                console.log('لا يمكن تحديث المنيو:', error.message);
            }
        }, 500);
        return;
    }

    if (customId.startsWith('cooldown_bypass_')) {
        const type = customId.split('_')[2]; // users, roles, or resps
        const config = loadCooldowns();
        const bypassList = config.bypass[type] || [];

        let description = `**قائمة التجاوز الحالية لـ ${type}:**\n`;
        if (bypassList.length > 0) {
            description += bypassList.map(id => {
                if (type === 'users') return `<@${id}>`;
                if (type === 'roles') return `<@&${id}>`;
                return id;
            }).join('\n');
        } else {
            description += 'لا يوجد حاليًا.';
        }

        const embed = actualColorManager.createEmbed()
            .setTitle(`إدارة تجاوز ${type}`)
            .setDescription(description);

        const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`cooldown_bypass_add_${type}`).setLabel('إضافة').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`cooldown_bypass_remove_${type}`).setLabel('إزالة').setStyle(ButtonStyle.Danger)
        );
        const backButton = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('cooldown_bypass').setLabel('➡️ العودة').setStyle(ButtonStyle.Secondary));

        await interaction.update({ embeds: [embed], components: [actionRow, backButton] });
        return;
    }

    if (customId.startsWith('cooldown_bypass_add_')) {
        const type = customId.split('_')[3];
        await interaction.reply({ content: `يرجى منشن أو كتابة ID الـ ${type} الذي تريد إضافته.`, ephemeral: true });

        const filter = m => m.author.id === interaction.user.id;
        const collector = interaction.channel.createMessageCollector({ filter, time: 60000, max: 1 });

        collector.on('collect', async msg => {
            await msg.delete().catch(() => {});
            const input = msg.content.trim();
            const id = input.replace(/[<@!&#>]/g, '');

            if (!/^\d{17,19}$/.test(id)) {
                return interaction.followUp({ content: 'ID غير صالح.', ephemeral: true });
            }

            const config = loadCooldowns();
            if (!config.bypass[type].includes(id)) {
                config.bypass[type].push(id);
                saveCooldowns(config);
                await interaction.followUp({ content: `✅ تم إضافة ${input} إلى قائمة التجاوز.`, ephemeral: true });
                
                const bypassList = config.bypass[type] || [];
                let description = `**قائمة التجاوز الحالية لـ ${type}:**\n`;
                if (bypassList.length > 0) {
                    description += bypassList.map(id => {
                        if (type === 'users') return `<@${id}>`;
                        if (type === 'roles') return `<@&${id}>`;
                        return id;
                    }).join('\n');
                } else {
                    description += 'لا يوجد حاليًا.';
                }

                const embed = actualColorManager.createEmbed()
                    .setTitle(`إدارة تجاوز ${type}`)
                    .setDescription(description);

                const actionRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`cooldown_bypass_add_${type}`).setLabel('إضافة').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`cooldown_bypass_remove_${type}`).setLabel('إزالة').setStyle(ButtonStyle.Danger)
                );
                const backButton = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('cooldown_bypass').setLabel('➡️ العودة').setStyle(ButtonStyle.Secondary));

                await interaction.message.edit({ embeds: [embed], components: [actionRow, backButton] }).catch(() => {});
            } else {
                await interaction.followUp({ content: 'هذا العنصر موجود بالفعل في القائمة.', ephemeral: true });
            }
        });
        return;
    }

    if (customId.startsWith('cooldown_bypass_remove_')) {
        const type = customId.split('_')[3];
        const config = loadCooldowns();
        const bypassList = config.bypass[type] || [];

        if (bypassList.length === 0) {
            return interaction.reply({ content: 'قائمة التجاوز فارغة بالفعل.', ephemeral: true });
        }

        const options = bypassList.map(id => ({ label: id, value: id }));
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`cooldown_bypass_confirm_remove_${type}`)
            .setPlaceholder(`اختر العناصر لإزالتها من قائمة تجاوز ${type}`)
            .setMinValues(1)
            .setMaxValues(options.length)
            .addOptions(options);

        await interaction.reply({ components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
        return;
    }

    if (customId.startsWith('cooldown_bypass_confirm_remove_')) {
        const type = customId.split('_')[4];
        const valuesToRemove = interaction.values;
        const config = loadCooldowns();

        config.bypass[type] = config.bypass[type].filter(id => !valuesToRemove.includes(id));
        saveCooldowns(config);

        await interaction.update({ content: '✅ تم إزالة العناصر المحددة.', components: [] });
        
        const bypassList = config.bypass[type] || [];
        let description = `**قائمة التجاوز الحالية لـ ${type}:**\n`;
        if (bypassList.length > 0) {
            description += bypassList.map(id => {
                if (type === 'users') return `<@${id}>`;
                if (type === 'roles') return `<@&${id}>`;
                return id;
            }).join('\n');
        } else {
            description += 'لا يوجد حاليًا.';
        }

        const embed = actualColorManager.createEmbed()
            .setTitle(`إدارة تجاوز ${type}`)
            .setDescription(description);

        const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`cooldown_bypass_add_${type}`).setLabel('إضافة').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`cooldown_bypass_remove_${type}`).setLabel('إزالة').setStyle(ButtonStyle.Danger)
        );
        const backButton = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('cooldown_bypass').setLabel('➡️ العودة').setStyle(ButtonStyle.Secondary));

        setTimeout(async () => {
            try {
                const mainMessage = interaction.message.channel.messages.cache.find(msg => 
                    msg.embeds.length > 0 && (msg.embeds[0].title === 'إعدادات الـ Cooldown' || msg.embeds[0].title === 'إدارة تجاوز الكولداون')
                );
                if (mainMessage) {
                    await mainMessage.edit({ embeds: [embed], components: [actionRow, backButton] }).catch(() => {});
                }
            } catch (error) {
                console.log('لا يمكن تحديث المنيو:', error.message);
            }
        }, 500);
        return;
    }

        if (interaction.customId === 'cooldown_set_default') {
            const cooldowns = loadCooldowns();
            const defaultEmbed = actualColorManager.createEmbed()
                .setDescription(`**يرجى إدخال الوقت الافتراضي للكولداون بالثواني:**\n\`الوقت الحالي: ${(cooldowns.default || 60000) / 1000} ثانية\``)
                .setThumbnail('https://cdn.discordapp.com/attachments/1398303368275038279/1398984234340847708/passage-of-time-icon-on-transparent-background-free-png.png?ex=68875919&is=68860799&hm=eb8e4ca9df98a147002078f9e41fe494db87d82d94b569481d29fdf0f477a276&');

            await interaction.reply({
                embeds: [defaultEmbed],
                ephemeral: true
            });

            const filter = m => m.author.id === interaction.user.id;
            const collector = interaction.channel.createMessageCollector({ filter, time: 60000, max: 1 });

            collector.on('collect', async (msg) => {
                const timeValue = parseInt(msg.content.trim());

                if (isNaN(timeValue) || timeValue < 1) {
                    await interaction.followUp({
                        content: '**❌ يرجى إدخال رقم صحيح أكبر من أو يساوي 1 ثانية !**',
                        ephemeral: true
                    });
                    return;
                }

                const timeInMs = timeValue * 1000;
                const cooldowns = loadCooldowns();
                cooldowns.default = timeInMs;
                saveCooldowns(cooldowns);

                await interaction.followUp({
                    content: `**✅ تم تعيين الـ cooldown الافتراضي إلى __${timeValue}__ ثانية بنجاح !**`,
                    ephemeral: true
                });

                // تحديث الرسالة الأساسية
                setTimeout(async () => {
                    try {
                        const mainMessage = interaction.message.channel.messages.cache.find(msg => 
                            msg.embeds.length > 0 && msg.embeds[0].title === 'إعدادات الـ Cooldown'
                        );
                        if (mainMessage) {
                            await mainMessage.edit({ embeds: [createMainEmbed()], components: [row] });
                        }
                    } catch (error) {
                        console.log('لا يمكن تحديث الرسالة الأساسية:', error.message);
                    }
                }, 500);

                // Delete user's message
                try {
                    await msg.delete();
                } catch (error) {
                    console.log('لا يمكن حذف الرسالة:', error.message);
                }
            });

            collector.on('end', (collected, reason) => {
                if (reason === 'time' && collected.size === 0) {
                    interaction.followUp({
                        content: '**انتهت المهلة الزمنية للإدخال.**',
                        ephemeral: true
                    }).catch(() => {});
                }
            });

        } else if (interaction.customId === 'cooldown_set_responsibility') {
            if (!responsibilities || Object.keys(responsibilities).length === 0) {
                return interaction.reply({ 
                    content: '- ** لا توجد مسؤوليات اصلا **', 
                    ephemeral: true 
                });
            }

            // إنشاء Modal للبحث عن المسؤوليات
            const modal = new ModalBuilder()
                .setCustomId('cooldown_search_responsibility_modal')
                .setTitle('بحث عن مسؤولية');

            const searchInput = new TextInputBuilder()
                .setCustomId('search_query')
                .setLabel('اكتب اسم المسؤولية للبحث')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder('مثال: مسؤول التصميم، مدير، admin');

            const actionRow = new ActionRowBuilder().addComponents(searchInput);
            modal.addComponents(actionRow);
            
            await interaction.showModal(modal);

        } else if (interaction.customId === 'cooldown_view') {
            const cooldowns = loadCooldowns();
            let description = `**الـ Cooldown الافتراضي:** ${(cooldowns.default || 60000) / 1000} ثانية\n\n`;

            if (cooldowns.responsibilities && Object.keys(cooldowns.responsibilities).length > 0) {
                description += '**مسؤوليات مخصصة:**\n';
                for (const [resp, time] of Object.entries(cooldowns.responsibilities)) {
                    description += `• **${resp}:** ${time / 1000} ثانية\n`;
                }
            } else {
                description += '**لا توجد مسؤوليات مخصصة**';
            }

            const embed = actualColorManager.createEmbed()
                .setTitle('إعدادات الـ Cooldown الحالية')
                .setDescription(description)
                .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400637278900191312/images__7_-removebg-preview.png?ex=688d5c9d&is=688c0b1d&hm=8d5c6d761dcf9bda65af44b9de09a2817cbc273f061eb1e39cc8ac20de37cfc0&');

            await interaction.reply({ embeds: [embed], ephemeral: true });

        } else if (interaction.customId === 'cooldown_reset') {
            const resetCooldowns = { default: 60000, responsibilities: {}, userCooldowns: {} };
            saveCooldowns(resetCooldowns);
            userCooldowns.clear();

            await interaction.reply({ 
                content: '**✅ تم إعادة تعيين جميع إعدادات الـ cooldown إلى الافتراضية !**', 
                ephemeral: true 
            });

            // تحديث الرسالة الأساسية فوراً
            setTimeout(async () => {
                try {
                    await interaction.message.edit({ embeds: [createMainEmbed()], components: [row] });
                } catch (error) {
                    console.log('لا يمكن تحديث الرسالة الأساسية:', error.message);
                }
            }, 500);

        } else if (interaction.customId === 'cooldown_search_responsibility_modal') {
            // معالجة البحث عن مسؤولية
            const searchQuery = interaction.fields.getTextInputValue('search_query').trim().toLowerCase();
            
            const matchingResponsibilities = Object.keys(responsibilities).filter(resp => 
                resp.toLowerCase().includes(searchQuery)
            );

            if (matchingResponsibilities.length === 0) {
                return interaction.reply({
                    content: `**❌ لم يتم العثور على أي مسؤولية تحتوي على: "${searchQuery}"**`,
                    ephemeral: true
                });
            }

            const pagination = createPaginatedResponsibilityArray(matchingResponsibilities, 0, 'cooldown_select_responsibility', 'اختر المسؤولية');
            
            await interaction.reply({
                content: `**تم العثور على ${matchingResponsibilities.length} مسؤولية**`,
                components: pagination.components,
                ephemeral: true
            });
            
            if (pagination.hasMultiplePages) {
                let currentPage = 0;
                const filter = i => i.user.id === interaction.user.id;
                const collector = interaction.channel.createMessageComponentCollector({ filter, time: 300000 });
                
                collector.on('collect', async i => {
                    const paginationAction = handlePaginationInteraction(i, 'cooldown_select_responsibility');
                    if (paginationAction) {
                        if (paginationAction.action === 'next') {
                            currentPage++;
                        } else if (paginationAction.action === 'prev') {
                            currentPage--;
                        }
                        
                        const newPagination = createPaginatedResponsibilityArray(matchingResponsibilities, currentPage, 'cooldown_select_responsibility', 'اختر المسؤولية');
                        currentPage = newPagination.currentPage;
                        
                        await i.update({
                            content: `**تم العثور على ${matchingResponsibilities.length} مسؤولية**`,
                            components: newPagination.components
                        });
                    }
                });
            }

        } else if (interaction.customId === 'cooldown_select_responsibility') {
            const selectedResp = interaction.values[0];
            const cooldowns = loadCooldowns();
            const currentTime = (cooldowns.responsibilities && cooldowns.responsibilities[selectedResp]) ? cooldowns.responsibilities[selectedResp] : (cooldowns.default || 60000);

            await interaction.reply({
                content: `**يرجى إدخال الوقت للمسؤولية "${selectedResp}" بالثواني:**\n\`الوقت الحالي: ${currentTime / 1000} ثانية\``,
                ephemeral: true
            });

            const filter = m => m.author.id === interaction.user.id;
            const collector = interaction.channel.createMessageCollector({ filter, time: 60000, max: 1 });

            collector.on('collect', async (msg) => {
                const timeValue = parseInt(msg.content.trim());

                if (isNaN(timeValue) || timeValue < 1) {
                    await interaction.followUp({
                        content: '**❌ يرجى إدخال رقم صحيح أكبر من أو يساوي 1 ثانية!**',
                        ephemeral: true
                    });
                    return;
                }

                const timeInMs = timeValue * 1000;
                // إعادة تحميل البيانات للتأكد من أحدث حالة
                const latestCooldowns = loadCooldowns();

                // التأكد من وجود المصفوفة
                if (!latestCooldowns.responsibilities) {
                    latestCooldowns.responsibilities = {};
                }

                // تعيين القيمة الجديدة
                latestCooldowns.responsibilities[selectedResp] = timeInMs;

                // حفظ فوري مع التحقق من النجاح
                const saveSuccess = saveCooldowns(latestCooldowns);

                if (saveSuccess) {
                    await interaction.followUp({
                        content: `**✅ تم تعيين cooldown لـ ${selectedResp} إلى __${timeValue}__ ثانية بنجاح!**`,
                        ephemeral: true
                    });

                    console.log(`✅ تم تعيين cooldown لـ ${selectedResp}: ${timeValue} ثانية`);
                } else {
                    await interaction.followUp({
                        content: `**❌ فشل في حفظ إعدادات الـ cooldown. حاول مرة أخرى.**`,
                        ephemeral: true
                    });
                    return;
                }

                // تحديث الرسالة الأساسية
                setTimeout(async () => {
                    try {
                        const mainMessage = interaction.message.channel.messages.cache.find(msg => 
                            msg.embeds.length > 0 && msg.embeds[0].title === 'إعدادات الـ Cooldown'
                        );
                        if (mainMessage) {
                            await mainMessage.edit({ embeds: [createMainEmbed()], components: [row] });
                        }
                    } catch (error) {
                        console.log('لا يمكن تحديث الرسالة الأساسية:', error.message);
                    }
                }, 500);

                // Delete user's message
                try {
                    await msg.delete();
                } catch (error) {
                    console.log('لا يمكن حذف الرسالة:', error.message);
                }
            });

            collector.on('end', (collected, reason) => {
                if (reason === 'time' && collected.size === 0) {
                    interaction.followUp({
                        content: '**انتهت المهلة الزمنية للإدخال.**',
                        ephemeral: true
                    }).catch(() => {});
                }
            });
        }

    } catch (error) {
        console.error('خطأ في معالجة تفاعل cooldown:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ 
                content: '❌ حدث خطأ أثناء معالجة طلبك!', 
                ephemeral: true 
            });
        }
    }
}

module.exports = { 
    name, 
    execute, 
    handleInteraction,
    checkCooldown, 
    startCooldown,
    loadUserCooldowns
};