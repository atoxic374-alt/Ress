const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { isUserBlocked } = require('./block.js');
const moment = require('moment-timezone');
const path = require('path');

const name = 'check';

function normalizeName(value) {
    return (value || '').toLowerCase().replace(/\s+/g, '');
}

function findBestRoleMatch(roles, searchTerm) {
    const normalizedSearch = normalizeName(searchTerm);
    return roles.find(role => normalizeName(role.name) === normalizedSearch)
        || roles.find(role => normalizeName(role.name).startsWith(normalizedSearch))
        || roles.find(role => normalizeName(role.name).includes(normalizedSearch));
}

function findBestMemberMatch(members, searchTerm) {
    const normalizedSearch = normalizeName(searchTerm);
    const getDisplayName = member => normalizeName(member.displayName);
    const getUsername = member => normalizeName(member.user.username);
    return members.find(member => getDisplayName(member) === normalizedSearch || getUsername(member) === normalizedSearch)
        || members.find(member => getDisplayName(member).startsWith(normalizedSearch) || getUsername(member).startsWith(normalizedSearch))
        || members.find(member => getDisplayName(member).includes(normalizedSearch) || getUsername(member).includes(normalizedSearch));
}

async function mapWithConcurrency(items, limit, mapper) {
    const results = [];
    for (let i = 0; i < items.length; i += limit) {
        const batch = items.slice(i, i + limit);
        const batchResults = await Promise.all(batch.map(mapper));
        results.push(...batchResults);
    }
    return results;
}

function getDatabaseManager() {
    const { getDatabase } = require('../utils/database.js');
    return getDatabase();
}

async function execute(message, args, { client, BOT_OWNERS, ADMIN_ROLES }) {
    if (isUserBlocked(message.author.id)) {
        const blockedEmbed = colorManager.createEmbed()
            .setDescription('**🚫 أنت محظور من استخدام أوامر البوت**\n**للاستفسار، تواصل مع إدارة السيرفر**')
            .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));
        await message.channel.send({ embeds: [blockedEmbed] });
        return;
    }

    const member = await message.guild.members.fetch(message.author.id);
    const hasAdministrator = member.permissions.has('Administrator');
    const isOwner = BOT_OWNERS.includes(message.author.id);
    
    const fs = require('fs');
    const botConfigPath = path.join(__dirname, '..', 'data', 'botConfig.json');
    const botConfig = JSON.parse(fs.readFileSync(botConfigPath, 'utf8'));
    const allowedRoles = botConfig.checkAllowedRoles || [];
    const hasAllowedRole = member.roles.cache.some(role => allowedRoles.includes(role.id));

    if (args[0] && args[0].toLowerCase() === 'allow') {
        if (!isOwner) return message.react('❌');
        
        let roleToAllow = message.mentions.roles.first() || message.guild.roles.cache.get(args[1]);
        if (!roleToAllow) return message.reply('**الرجاء منشن رول أو كتابة ID الرول المسموح له**');
        
        if (!botConfig.checkAllowedRoles) botConfig.checkAllowedRoles = [];
        if (!botConfig.checkAllowedRoles.includes(roleToAllow.id)) {
            botConfig.checkAllowedRoles.push(roleToAllow.id);
            fs.writeFileSync(botConfigPath, JSON.stringify(botConfig, null, 2));
            return message.reply(`**✅ تم السماح للرول ${roleToAllow.name} باستخدام أمر check**`);
        } else {
            return message.reply(`**⚠️ الرول ${roleToAllow.name} مسموح له بالفعل**`);
        }
    }

    if (!hasAdministrator && !hasAllowedRole) {
        await message.react('❌');
        return;
    }

    if (args.length === 0) {
        await message.channel.send('**يرجى منشن رول أو عضو أو كتابة الآيدي أو الاسم**');
        return;
    }

    const mentionRegex = /<@!?(\d+)>|<@&(\d+)>|(\b\d{17,19}\b)/g;
    const matches = [...message.content.matchAll(mentionRegex)];
    const uniqueIds = [...new Set(matches.map(m => m[1] || m[2] || m[3]).filter(Boolean))];

    if (uniqueIds.length > 0) {
        await mapWithConcurrency(uniqueIds, 5, async (id) => {
            const roleMatch = message.guild.roles.cache.get(id);
            const userMatch = await client.users.fetch(id).catch(() => null);

            if (roleMatch) {
                await showRoleActivityStats(message, roleMatch, client);
            } else if (userMatch) {
                await showUserActivityStats(message, userMatch, client);
            }
        });
        return;
    }

    const searchTerm = args.join(' ');
    const roleByName = findBestRoleMatch(message.guild.roles.cache, searchTerm);
    const memberByName = findBestMemberMatch(message.guild.members.cache, searchTerm);

    if (roleByName) {
        await showRoleActivityStats(message, roleByName, client);
        return;
    }

    if (memberByName) {
        await showUserActivityStats(message, memberByName.user, client);
        return;
    }

    await message.channel.send('**لم يتم العثور على منشن أو آيدي أو اسم مطابق في الرسالة**');
}

async function getColorIndicator(userId, client, dbManager) {
    try {
        const now = moment().tz('Asia/Riyadh');
        const weekStart = now.clone().startOf('week');
        const monthStart = now.clone().startOf('month');
        const dayStart = now.clone().startOf('day');

        const weeklyStats = await dbManager.all(`
            SELECT SUM(voice_time) as voiceTime, SUM(messages) as messages
            FROM daily_activity 
            WHERE user_id = ? AND date >= ?
        `, [userId, weekStart.format('YYYY-MM-DD')]);

        const monthlyStats = await dbManager.all(`
            SELECT SUM(voice_time) as voiceTime, SUM(messages) as messages
            FROM daily_activity 
            WHERE user_id = ? AND date >= ?
        `, [userId, monthStart.format('YYYY-MM-DD')]);

        const dailyStats = await dbManager.all(`
            SELECT SUM(voice_time) as voiceTime, SUM(messages) as messages
            FROM daily_activity 
            WHERE user_id = ? AND date >= ?
        `, [userId, dayStart.format('YYYY-MM-DD')]);

        const activeSessions = client.voiceSessions || new Map();
        let liveDuration = 0;
        if (activeSessions.has(userId)) {
            const session = activeSessions.get(userId);
            if (session && !session.isAFK) {
                const liveStart = session.lastTrackedTime || session.startTime || session.sessionStartTime;
                liveDuration = Math.max(0, Date.now() - liveStart);
            }
        }

        const weeklyVoiceTime = (weeklyStats[0]?.voiceTime || 0) + liveDuration;
        const weeklyMessages = weeklyStats[0]?.messages || 0;
        const monthlyVoiceTime = (monthlyStats[0]?.voiceTime || 0) + liveDuration;
        const monthlyMessages = monthlyStats[0]?.messages || 0;
        const dailyVoiceTime = (dailyStats[0]?.voiceTime || 0) + liveDuration;
        const dailyMessages = dailyStats[0]?.messages || 0;

        const weeklyXP = Math.floor(weeklyMessages / 10);
        const monthlyXP = Math.floor(monthlyMessages / 10);
        const dailyXP = Math.floor(dailyMessages / 10);

        const weeklyTotal = weeklyVoiceTime + weeklyXP;
        const monthlyTotal = monthlyVoiceTime + monthlyXP;
        const dailyTotal = dailyVoiceTime + dailyXP;

        const allWeeklyUsers = await dbManager.all(`
            SELECT user_id, SUM(voice_time) + (SUM(messages) / 10) as total
            FROM daily_activity 
            WHERE date >= ?
            GROUP BY user_id
            ORDER BY total DESC
        `, [weekStart.format('YYYY-MM-DD')]);

        const allMonthlyUsers = await dbManager.all(`
            SELECT user_id, SUM(voice_time) + (SUM(messages) / 10) as total
            FROM daily_activity 
            WHERE date >= ?
            GROUP BY user_id
            ORDER BY total DESC
        `, [monthStart.format('YYYY-MM-DD')]);

        const allDailyUsers = await dbManager.all(`
            SELECT user_id, SUM(voice_time) + (SUM(messages) / 10) as total
            FROM daily_activity 
            WHERE date >= ?
            GROUP BY user_id
            ORDER BY total DESC
        `, [dayStart.format('YYYY-MM-DD')]);

        const weeklyRank = allWeeklyUsers.findIndex(u => u.user_id === userId) + 1;
        const monthlyRank = allMonthlyUsers.findIndex(u => u.user_id === userId) + 1;
        const dailyRank = allDailyUsers.findIndex(u => u.user_id === userId) + 1;

        // فحص الترتيب في الشات الشهري (XP فقط)
        const allMonthlyChat = await dbManager.all(`
            SELECT user_id, SUM(messages) / 10 as xp
            FROM daily_activity 
            WHERE date >= ?
            GROUP BY user_id
            ORDER BY xp DESC
        `, [monthStart.format('YYYY-MM-DD')]);

        const monthlyChatRank = allMonthlyChat.findIndex(u => u.user_id === userId) + 1;

        // فحص الترتيب في الشات الأسبوعي (XP فقط)
        const allWeeklyChat = await dbManager.all(`
            SELECT user_id, SUM(messages) / 10 as xp
            FROM daily_activity 
            WHERE date >= ?
            GROUP BY user_id
            ORDER BY xp DESC
        `, [weekStart.format('YYYY-MM-DD')]);

        const weeklyChatRank = allWeeklyChat.findIndex(u => u.user_id === userId) + 1;

        // فحص الترتيب في الفويس الشهري فقط
        const allMonthlyVoice = await dbManager.all(`
            SELECT user_id, SUM(voice_time) as voice_time
            FROM daily_activity 
            WHERE date >= ?
            GROUP BY user_id
            ORDER BY voice_time DESC
        `, [monthStart.format('YYYY-MM-DD')]);

        const monthlyVoiceRank = allMonthlyVoice.findIndex(u => u.user_id === userId) + 1;

        // فحص الترتيب في الفويس الأسبوعي فقط
        const allWeeklyVoice = await dbManager.all(`
            SELECT user_id, SUM(voice_time) as voice_time
            FROM daily_activity 
            WHERE date >= ?
            GROUP BY user_id
            ORDER BY voice_time DESC
        `, [weekStart.format('YYYY-MM-DD')]);

        const weeklyVoiceRank = allWeeklyVoice.findIndex(u => u.user_id === userId) + 1;

        // حساب عدد مرات الحصول على توب 1 يومي خلال الأسبوع
        const dailyTop1Count = await dbManager.all(`
            SELECT COUNT(*) as count
            FROM (
                SELECT date, user_id, 
                       SUM(voice_time) + (SUM(messages) / 10) as total,
                       RANK() OVER (PARTITION BY date ORDER BY SUM(voice_time) + (SUM(messages) / 10) DESC) as rank
                FROM daily_activity
                WHERE date >= ?
                GROUP BY date, user_id
            )
            WHERE user_id = ? AND rank = 1
        `, [weekStart.format('YYYY-MM-DD'), userId]);

        const top1DailyCount = dailyTop1Count[0]?.count || 0;

        // نظام شامل: أخضر إذا كان في توب 5 في أي من الفئات أو حصل على توب 1 يومي 3 مرات أسبوعياً
        if (monthlyRank > 0 && monthlyRank <= 5) return '<:emoji_11:1429246636936138823>';
        if (monthlyChatRank > 0 && monthlyChatRank <= 5) return '<:emoji_11:1429246636936138823>';
        if (monthlyVoiceRank > 0 && monthlyVoiceRank <= 5) return '<:emoji_11:1429246636936138823>';
        if (weeklyRank > 0 && weeklyRank <= 5) return '<:emoji_11:1429246636936138823>';
        if (weeklyChatRank > 0 && weeklyChatRank <= 5) return '<:emoji_11:1429246636936138823>';
        if (weeklyVoiceRank > 0 && weeklyVoiceRank <= 5) return '<:emoji_11:1429246636936138823>';
        if (top1DailyCount >= 3) return '<:emoji_11:1429246636936138823>'; // 3 مرات توب 1 يومي = أخضر
        
        // أصفر إذا كان في 6-10 في أي من الفئات أو حصل على توب 1 يومي مرتين
        if (monthlyRank > 5 && monthlyRank <= 10) return '<:emoji_10:1429246610784653412>';
        if (monthlyChatRank > 5 && monthlyChatRank <= 10) return '<:emoji_10:1429246610784653412>';
        if (monthlyVoiceRank > 5 && monthlyVoiceRank <= 10) return '<:emoji_10:1429246610784653412>';
        if (weeklyRank > 5 && weeklyRank <= 10) return '<:emoji_10:1429246610784653412>';
        if (weeklyChatRank > 5 && weeklyChatRank <= 10) return '<:emoji_10:1429246610784653412>';
        if (weeklyVoiceRank > 5 && weeklyVoiceRank <= 10) return '<:emoji_10:1429246610784653412>';
        if (top1DailyCount === 2) return '<:emoji_10:1429246610784653412>'; // مرتين توب 1 يومي = أصفر

        return '<:emoji_9:1429246586289918063>';
    } catch (error) {
        console.error('خطأ في حساب مؤشر اللون:', error);
        return '<:emoji_9:1429246586289918063>';
    }
}

async function showRoleActivityStats(message, role, client) {
    let dbManager;
    try {
        dbManager = getDatabaseManager();
        if (!dbManager || !dbManager.isInitialized) {
            await message.channel.send('**❌ خطأ في الاتصال بقاعدة البيانات**');
            return;
        }
    } catch (error) {
        console.error('خطأ في الحصول على قاعدة البيانات:', error);
        await message.channel.send('**❌ خطأ في الاتصال بقاعدة البيانات**');
        return;
    }

    const now = moment().tz('Asia/Riyadh');
    const monthStart = now.clone().startOf('month');

    const members = role.members.filter(m => !m.user.bot).map(m => m.user.id);

    if (members.length === 0) {
        await message.channel.send('**لا يوجد أعضاء في هذا الرول**');
        return;
    }

    let userStats;
    try {
        const userStatsPromises = members.map(async (userId) => {
            try {
                const monthlyStats = await dbManager.all(`
                    SELECT SUM(voice_time) as voiceTime, SUM(messages) as messages
                    FROM daily_activity 
                    WHERE user_id = ? AND date >= ?
                `, [userId, monthStart.format('YYYY-MM-DD')]);

                const voiceTime = monthlyStats[0]?.voiceTime || 0;
                const messages = monthlyStats[0]?.messages || 0;
                const xp = Math.floor(messages / 10);

                const color = await getColorIndicator(userId, client, dbManager);

                return {
                    userId,
                    voiceTime,
                    messages,
                    xp,
                    color,
                    total: voiceTime + xp
                };
            } catch (error) {
                console.error(`خطأ في جلب إحصائيات المستخدم ${userId}:`, error);
                return null;
            }
        });

        userStats = (await Promise.all(userStatsPromises))
            .filter(stat => stat !== null)
            .sort((a, b) => b.total - a.total);

        if (userStats.length === 0) {
            await message.channel.send('**لا يوجد نشاط لهذا الرول **');
            return;
        }
    } catch (error) {
        console.error('خطأ في جلب إحصائيات الرول:', error);
        await message.channel.send('**❌ حدث خطأ أثناء جلب الإحصائيات**');
        return;
    }

    let currentPage = 0;
    const pageSize = 10;
    const maxPages = Math.ceil(userStats.length / pageSize);

    const buildEmbed = (page) => {
        const start = page * pageSize;
        const end = start + pageSize;
        const pageData = userStats.slice(start, end);

        const description = pageData.map((stat, idx) => {
            const rank = start + idx + 1;
            const voiceTimeFormatted = formatDuration(stat.voiceTime);
            return `${stat.color} **#${rank}** - <@${stat.userId}>\n**Voice :** ${voiceTimeFormatted} | **Chat :** **${stat.xp}xp**`;
        }).join('\n\n');

        const embed = colorManager.createEmbed()
            .setTitle(`Check - ${role.name}`)
            .setDescription(description || 'لا يوجد نشاط')
            .setFooter({ text: `الصفحة ${page + 1} من ${maxPages}` })
            .setTimestamp();

        return embed;
    };

    const warningButton = new ButtonBuilder()
        .setCustomId('send_warning')
        .setLabel('Alert')
.setEmoji('<:emoji_67:1442588426066198528>')
        .setStyle(ButtonStyle.Danger);

    const prevButton = new ButtonBuilder()
        .setCustomId('prev_page')
        .setEmoji('<:emoji_13:1429263136136888501>')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 0);

    const nextButton = new ButtonBuilder()
        .setCustomId('next_page')
        .setEmoji('<:emoji_14:1429263186539974708>')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage >= maxPages - 1);

    const row1 = new ActionRowBuilder().addComponents(warningButton);
    const row2 = new ActionRowBuilder().addComponents(prevButton, nextButton);

    const sentMessage = await message.channel.send({ 
        embeds: [buildEmbed(currentPage)], 
        components: [row1, row2] 
    });

    const filter = i => i.user.id === message.author.id;
    const collector = sentMessage.createMessageComponentCollector({ filter, time: 600000 });

    let warningText = '';

    collector.on('collect', async interaction => {
        try {
            if (interaction.customId === 'prev_page' && currentPage > 0) {
                currentPage--;
                const newPrevButton = ButtonBuilder.from(prevButton).setDisabled(currentPage === 0);
                const newNextButton = ButtonBuilder.from(nextButton).setDisabled(currentPage >= maxPages - 1);
                const newRow2 = new ActionRowBuilder().addComponents(newPrevButton, newNextButton);

                await interaction.update({ embeds: [buildEmbed(currentPage)], components: [row1, newRow2] });
            } else if (interaction.customId === 'next_page' && currentPage < maxPages - 1) {
                currentPage++;
                const newPrevButton = ButtonBuilder.from(prevButton).setDisabled(currentPage === 0);
                const newNextButton = ButtonBuilder.from(nextButton).setDisabled(currentPage >= maxPages - 1);
                const newRow2 = new ActionRowBuilder().addComponents(newPrevButton, newNextButton);

                await interaction.update({ embeds: [buildEmbed(currentPage)], components: [row1, newRow2] });
            } else if (interaction.customId === 'send_warning') {
                const modal = new ModalBuilder()
                    .setCustomId('warning_modal')
                    .setTitle('Send Alert');

                const warningInput = new TextInputBuilder()
                    .setCustomId('warning_text')
                    .setLabel('اكتب التنبيه')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(1000);

                const actionRow = new ActionRowBuilder().addComponents(warningInput);
                modal.addComponents(actionRow);

                await interaction.showModal(modal);

                try {
                    const modalSubmit = await interaction.awaitModalSubmit({ 
                        time: 300000,
                        filter: i => i.customId === 'warning_modal' && i.user.id === interaction.user.id
                    });

                    warningText = modalSubmit.fields.getTextInputValue('warning_text');

                    const greenUsers = userStats.filter(stat => stat.color === '<:emoji_11:1429246636936138823>');
                    const yellowUsers = userStats.filter(stat => stat.color === '<:emoji_10:1429246610784653412>');
                    const redUsers = userStats.filter(stat => stat.color === '<:emoji_9:1429246586289918063>');

                    const colorOptions = [];
                    if (greenUsers.length > 0) {
                        colorOptions.push({
                            label: 'أخضر (توب 5)',
                            value: 'green',
                            emoji: '<:emoji_11:1429246636936138823>',
                            description: `عدد الأعضاء : ${greenUsers.length}`
                        });
                    }
                    if (yellowUsers.length > 0) {
                        colorOptions.push({
                            label: 'أصفر (توب 6-10)',
                            value: 'yellow',
                            emoji: '<:emoji_10:1429246610784653412>',
                            description: `عدد الأعضاء : ${yellowUsers.length}`
                        });
                    }
                    if (redUsers.length > 0) {
                        colorOptions.push({
                            label: 'أحمر (باقي الأعضاء)',
                            value: 'red',
                            emoji: '<:emoji_9:1429246586289918063>',
                            description: `عدد الأعضاء : ${redUsers.length}`
                        });
                    }

                    if (colorOptions.length === 0) {
                        await modalSubmit.reply({ 
                            content: '**❌ لا يوجد أعضاء للتنبيه**', 
                            ephemeral: true
                        });
                        return;
                    }

                    const selectMenu = new StringSelectMenuBuilder()
                        .setCustomId('select_warning_recipients')
                        .setPlaceholder('اختر اللون للتنبيه')
                        .setMinValues(1)
                        .setMaxValues(colorOptions.length);

                    selectMenu.addOptions(colorOptions);

                    const selectRow = new ActionRowBuilder().addComponents(selectMenu);

                    await modalSubmit.reply({ 
                        content: '**ا ختر اللون للأعضاء الذين تريد تنبيههم:**', 
                        components: [selectRow], 
                        ephemeral: true
                    });

                    try {
                        const selectInteraction = await modalSubmit.channel.awaitMessageComponent({
                            filter: i => i.customId === 'select_warning_recipients' && i.user.id === interaction.user.id,
                            time: 300000
                        });

                        const selectedColors = selectInteraction.values;
                        let selectedUserIds = [];

                        if (selectedColors.includes('green')) {
                            selectedUserIds.push(...greenUsers.map(u => u.userId));
                        }
                        if (selectedColors.includes('yellow')) {
                            selectedUserIds.push(...yellowUsers.map(u => u.userId));
                        }
                        if (selectedColors.includes('red')) {
                            selectedUserIds.push(...redUsers.map(u => u.userId));
                        }
                        selectedUserIds = [...new Set(selectedUserIds)];

                        collector.stop();
                        
                        await selectInteraction.deferUpdate();

                        const progressEmbed = colorManager.createEmbed()
                            .setTitle('**جاري إرسال التنبيه للأعضاء...**')
                            .setDescription(`**✅  Done to :** 0\n**❌ Failed to:** 0`)
                            .setFooter({ text: 'By Ahmed.' })
                            .setTimestamp();

                        await sentMessage.edit({ 
                            embeds: [progressEmbed],
                            components: [] 
                        });

                        const sender = selectInteraction.user;
                        const date = moment().tz('Asia/Riyadh').format('YYYY-MM-DD HH:mm');
                        let successCount = 0;
                        let failCount = 0;
                        let rateLimitedCount = 0;
                        let processedCount = 0;

                        // نظام Batching - معالجة 5 أعضاء في كل دفعة
                        const BATCH_SIZE = 5;
                        const BATCH_DELAY = 3000; // 3 ثواني بين كل دفعة
                        const MESSAGE_DELAY = 1200; // 1.2 ثانية بين كل رسالة
                        const MAX_RETRIES = 2;

                        // تقسيم الأعضاء إلى دفعات
                        const batches = [];
                        for (let i = 0; i < selectedUserIds.length; i += BATCH_SIZE) {
                            batches.push(selectedUserIds.slice(i, i + BATCH_SIZE));
                        }

                        console.log(`📦 تم تقسيم ${selectedUserIds.length} عضو إلى ${batches.length} دفعة`);

                        // دالة لإرسال رسالة مع إعادة محاولة
                        async function sendDMWithRetry(user, embed, retries = MAX_RETRIES) {
                            for (let attempt = 0; attempt <= retries; attempt++) {
                                try {
                                    await user.send({ embeds: [embed] });
                                    return { success: true };
                                } catch (error) {
                                    if (error.code === 429) {
                                        const retryAfter = error.retry_after || 2;
                                        console.warn(`⏳ Rate limit - انتظار ${retryAfter}s قبل إعادة المحاولة ${attempt + 1}/${retries}`);
                                        if (attempt < retries) {
                                            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                                            continue;
                                        }
                                        return { success: false, rateLimited: true };
                                    } else if (error.code === 50007) {
                                        // Cannot send messages to this user
                                        return { success: false, cannotDM: true };
                                    } else {
                                        return { success: false, error: error.message };
                                    }
                                }
                            }
                            return { success: false, rateLimited: true };
                        }

                        // معالجة كل دفعة
                        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
                            const batch = batches[batchIndex];
                            console.log(`📨 معالجة الدفعة ${batchIndex + 1}/${batches.length} (${batch.length} أعضاء)`);

                            // تحديث الرسالة كل 3 دفعات
                            if (batchIndex % 3 === 0) {
                                const updateEmbed = colorManager.createEmbed()
                                    .setTitle('**جاري إرسال التنبيه للأعضاء...**')
                                    .setDescription(`**✅ Done Send :** ${successCount}\n**❌ Failed :** ${failCount}` + 
                                        (rateLimitedCount > 0 ? `\n**<:emoji_53:1430733925227171980> Rate Limited :** ${rateLimitedCount}` : ''))
                                    .setFooter({ text: 'By Ahmed.' })
                                    .setTimestamp();

                                await sentMessage.edit({ embeds: [updateEmbed] }).catch(() => {});
                            }

                            for (const userId of batch) {
                                try {
                                    const user = await client.users.fetch(userId);
                                    const warningEmbed = colorManager.createEmbed()
                                        .setTitle('Alert')
                                        .setDescription(`**تم تنبيهك بواسطة :** ${sender}\n**بتاريخ :** ${date}\n\n**التنبيه :**\n${warningText}`)
                                        .setTimestamp();

                                    const result = await sendDMWithRetry(user, warningEmbed);
                                    
                                    if (result.success) {
                                        successCount++;
                                        console.log(`✅ تم إرسال تنبيه لـ ${user.tag}`);
                                    } else if (result.rateLimited) {
                                        rateLimitedCount++;
                                        console.warn(`⚠️ Rate limited - ${user.tag}`);
                                    } else if (result.cannotDM) {
                                        failCount++;
                                        console.error(`❌ DMs مغلقة - ${user.tag}`);
                                    } else {
                                        failCount++;
                                        console.error(`❌ فشل الإرسال - ${user.tag}: ${result.error}`);
                                    }

                                    // تأخير بين كل رسالة
                                    await new Promise(resolve => setTimeout(resolve, MESSAGE_DELAY));
                                } catch (error) {
                                    failCount++;
                                    console.error(`❌ فشل إرسال رسالة إلى ${userId}:`, error.message);
                                }

                                processedCount++;
                            }

                            // تأخير بين الدفعات (ما عدا الدفعة الأخيرة)
                            if (batchIndex < batches.length - 1) {
                                console.log(`⏸️ انتظار ${BATCH_DELAY / 1000}s قبل الدفعة التالية...`);
                                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
                            }
                        }

                        const colorNames = selectedColors.map(c => {
                            if (c === 'green') return 'Green <:emoji_11:1429246636936138823>';
                            if (c === 'yellow') return 'Yellow <:emoji_10:1429246610784653412>';
                            if (c === 'red') return 'Red <:emoji_9:1429246586289918063>';
                        }).join(', ');

                        const finalEmbed = colorManager.createEmbed()
                            .setTitle('** Done sended ✅️**')
                            .setDescription(`**✅  Done to :** ${successCount}\n**❌ Failed :** ${failCount}` +
                                (rateLimitedCount > 0 ? `\n**<:emoji_53:1430733925227171980> Rate Limited :** ${rateLimitedCount}` : '') +
                                `\n**Colors :** ${colorNames}\n**<:emoji_51:1430733172710183103> Final :** ${Math.round((successCount / Math.max(selectedUserIds.length, 1)) * 100)}%`)
                            .setFooter({ text: 'By Ahmed.' })
                            .setTimestamp();

                        try {
                            await sentMessage.edit({ embeds: [finalEmbed] });
                        } catch (updateError) {
                            console.error('فشل تحديث الرسالة، سأرسل في القناة:', updateError.message);
                            await message.channel.send({ embeds: [finalEmbed] }).catch(() => {});
                        }
                    } catch (selectError) {
                        console.error('خطأ في انتظار اختيار المستلمين:', selectError);
                        await modalSubmit.editReply({ 
                            content: '**❌ انتهت مهلة اختيار المستلمين**', 
                            components: [] 
                        }).catch(() => {});
                    }
                } catch (error) {
                    console.error('خطأ في انتظار Modal:', error);
                }
            }
        } catch (error) {
            console.error('خطأ في معالج check:', error);
        }
    });

    collector.on('end', () => {
        sentMessage.edit({ components: [] }).catch(() => {});
    });
}

async function showUserActivityStats(message, user, client) {
    let dbManager;
    try {
        dbManager = getDatabaseManager();
        if (!dbManager || !dbManager.isInitialized) {
            await message.channel.send('**❌ خطأ في الاتصال بقاعدة البيانات**');
            return;
        }
    } catch (error) {
        console.error('خطأ في الحصول على قاعدة البيانات:', error);
        await message.channel.send('**❌ خطأ في الاتصال بقاعدة البيانات**');
        return;
    }

    const now = moment().tz('Asia/Riyadh');
    const monthStart = now.clone().startOf('month');

    try {
        const monthlyStats = await dbManager.all(`
            SELECT SUM(voice_time) as voiceTime, SUM(messages) as messages
            FROM daily_activity 
            WHERE user_id = ? AND date >= ?
        `, [user.id, monthStart.format('YYYY-MM-DD')]);

        const voiceTime = monthlyStats[0]?.voiceTime || 0;
        const messages = monthlyStats[0]?.messages || 0;
        const xp = Math.floor(messages / 10);
        const colorEmoji = await getColorIndicator(user.id, client, dbManager);

        const voiceTimeFormatted = formatDuration(voiceTime);

        const embed = colorManager.createEmbed()
            .setTitle(` Check - <@${user.id}>`)
            .setDescription(`${colorEmoji} **Voice :** **${voiceTimeFormatted}**\n**Chat :** **${xp}xp**`)
            .setThumbnail(user.displayAvatarURL({ dynamic: true }))
            .setFooter({ text: ` Checking : ${user.username}` })
            .setTimestamp();

        await message.channel.send({ embeds: [embed] });
    } catch (error) {
        console.error('خطأ في جلب إحصائيات المستخدم:', error);
        await message.channel.send('**❌ حدث خطأ أثناء جلب الإحصائيات**');
    }
}

function formatDuration(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
        return `${minutes}m ${secs}s`;
    } else {
        return `${secs}s`;
    }
}

module.exports = { name, execute };
