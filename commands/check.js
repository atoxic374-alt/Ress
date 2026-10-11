const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { isUserBlocked } = require('./block.js');
const moment = require('moment-timezone');
const allowStore = require('../utils/allowStore');

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

async function fetchRoleMembers(guild, role) {
    // role.members is cache-only. On large guilds it can contain only the
    // members received so far, which makes check report an incorrect count.
    try {
        if (guild.memberCount > guild.members.cache.size) {
            await guild.members.fetch();
        }
    } catch (error) {
        console.error(`تعذر تحميل أعضاء السيرفر قبل فحص الرول ${role.id}:`, error);
    }

    return [...guild.members.cache.values()]
        .filter(member => member.roles.cache.has(role.id) && !member.user.bot);
}

function getDatabaseManager() {
    const { getDatabase } = require('../utils/database.js');
    return getDatabase();
}

function buildActivitySource(guildId) {
    if (!guildId) return 'daily_activity';
    // النشاط الجديد يُحفظ لكل سيرفر في guild_daily_activity؛ نضم إليه
    // السجلات القديمة غير المعزولة حتى لا تختفي بيانات ما قبل هذا النظام.
    return `(SELECT date, user_id, voice_time, messages FROM guild_daily_activity WHERE guild_id = ?
            UNION ALL SELECT date, user_id, voice_time, messages FROM daily_activity)`;
}

function activityQueryParams(guildId, ...params) {
    return guildId ? [String(guildId), ...params] : params;
}

async function getActivityTotals(dbManager, guildId, userId, fromDate) {
    const source = buildActivitySource(guildId);
    return dbManager.get(`
        SELECT COALESCE(SUM(voice_time), 0) AS voiceTime,
               COALESCE(SUM(messages), 0) AS messages
        FROM ${source}
        WHERE user_id = ? AND date >= ?
    `, activityQueryParams(guildId, String(userId), fromDate));
}

function getLiveVoiceDuration(client, userId, guildId, fromTimestamp = 0, now = Date.now()) {
    const session = client?.voiceSessions?.get(String(userId));
    if (!session || session.isAFK) return 0;
    if (guildId && session.guildId && String(session.guildId) !== String(guildId)) return 0;
    const liveStart = Number(session.lastTrackedTime || session.startTime || session.sessionStartTime);
    if (!Number.isFinite(liveStart) || liveStart <= 0) return 0;
    return Math.max(0, now - Math.max(liveStart, Number(fromTimestamp) || 0));
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
    const allowConfig = allowStore.loadAllowConfig().check;
    const hasAllowedRole = member.roles.cache.some(role => allowConfig.roles.includes(role.id));
    const hasAllowedUser = allowConfig.users.includes(member.id);

    if (!hasAdministrator && !hasAllowedRole && !hasAllowedUser) {
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

async function getColorIndicator(userId, client, dbManager, guildId = null) {
    try {
        const now = moment().tz('Asia/Riyadh');
        const weekStart = now.clone().startOf('week').format('YYYY-MM-DD');
        const monthStart = now.clone().startOf('month').format('YYYY-MM-DD');
        const dayStart = now.clone().startOf('day').format('YYYY-MM-DD');
        const source = buildActivitySource(guildId);
        const params = (...values) => activityQueryParams(guildId, ...values);
        const ranked = async (fromDate, score) => dbManager.all(`
            SELECT user_id, ${score} AS score
            FROM ${source}
            WHERE date >= ?
            GROUP BY user_id
            ORDER BY score DESC
        `, params(fromDate));
        const rankOf = rows => rows.findIndex(row => String(row.user_id) === String(userId)) + 1;

        const [weeklyTotal, monthlyTotal, dailyTotal, monthlyChat, weeklyChat, monthlyVoice, weeklyVoice] = await Promise.all([
            ranked(weekStart, 'SUM(voice_time) + (SUM(messages) / 10)'),
            ranked(monthStart, 'SUM(voice_time) + (SUM(messages) / 10)'),
            ranked(dayStart, 'SUM(voice_time) + (SUM(messages) / 10)'),
            ranked(monthStart, 'SUM(messages) / 10'),
            ranked(weekStart, 'SUM(messages) / 10'),
            ranked(monthStart, 'SUM(voice_time)'),
            ranked(weekStart, 'SUM(voice_time)')
        ]);

        const [monthlyRank, monthlyChatRank, monthlyVoiceRank, weeklyRank, weeklyChatRank, weeklyVoiceRank] = [
            rankOf(monthlyTotal), rankOf(monthlyChat), rankOf(monthlyVoice),
            rankOf(weeklyTotal), rankOf(weeklyChat), rankOf(weeklyVoice)
        ];
        const dailyTop1Count = await dbManager.get(`
            SELECT COUNT(*) AS count FROM (
                SELECT date, user_id,
                       RANK() OVER (PARTITION BY date ORDER BY SUM(voice_time) + (SUM(messages) / 10) DESC) AS rank
                FROM ${source}
                WHERE date >= ?
                GROUP BY date, user_id
            )
            WHERE user_id = ? AND rank = 1
        `, params(weekStart, String(userId)));
        const top1DailyCount = Number(dailyTop1Count?.count || 0);

        if ([monthlyRank, monthlyChatRank, monthlyVoiceRank, weeklyRank, weeklyChatRank, weeklyVoiceRank].some(rank => rank > 0 && rank <= 5) || top1DailyCount >= 3) {
            return '<:emoji_11:1429246636936138823>';
        }
        if ([monthlyRank, monthlyChatRank, monthlyVoiceRank, weeklyRank, weeklyChatRank, weeklyVoiceRank].some(rank => rank > 5 && rank <= 10) || top1DailyCount === 2) {
            return '<:emoji_10:1429246610784653412>';
        }
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

    const guildId = message.guild.id;
    const now = moment().tz('Asia/Riyadh');
    const monthStart = now.clone().startOf('month');

    const roleMembers = await fetchRoleMembers(message.guild, role);
    const members = roleMembers.map(m => m.user.id);

    if (members.length === 0) {
        await message.channel.send('**لا يوجد أعضاء في هذا الرول**');
        return;
    }

    let userStats;
    try {
        const userStatsPromises = members.map(async (userId) => {
            try {
                const monthlyStats = await getActivityTotals(dbManager, guildId, userId, monthStart.format('YYYY-MM-DD'));
                const voiceTime = (monthlyStats?.voiceTime || 0)
                    + getLiveVoiceDuration(client, userId, guildId, monthStart.valueOf());
                const messages = monthlyStats?.messages || 0;
                const xp = Math.floor(messages / 10);

                const color = await getColorIndicator(userId, client, dbManager, guildId);

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
                try {
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
                        await interaction.reply({ 
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

                    await interaction.reply({ 
                        content: '**اختر لون الأعضاء الذين تريد إرسال الرسالة لهم:**', 
                        components: [selectRow], 
                        ephemeral: true
                    });

                    try {
                        const selectInteraction = await interaction.channel.awaitMessageComponent({
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

                        await selectInteraction.update({
                            content: `**✅ تم اختيار ${selectedUserIds.length} عضو.**\n**الآن ارسل نص الرسالة هنا خلال 5 دقائق.**\n**يمكنك إرفاق صور مع الرسالة (حد دسكورد في الرسالة الواحدة: 10 مرفقات، والنص: 2000 حرف).**`,
                            components: []
                        });

                        const collected = await message.channel.awaitMessages({
                            filter: m => m.author.id === interaction.user.id,
                            max: 1,
                            time: 300000,
                            errors: ['time']
                        });
                        const warningMessage = collected.first();
                        const warningText = (warningMessage.content || '').trim();
                        const attachments = [...warningMessage.attachments.values()]
                            .filter(attachment => attachment.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(attachment.name || attachment.url))
                            .slice(0, 10);

                        if (!warningText && attachments.length === 0) {
                            await message.channel.send('**❌ يجب إرسال نص أو صورة واحدة على الأقل.**');
                            return;
                        }

                        const senderMember = await message.guild.members.fetch(selectInteraction.user.id).catch(() => null);
                        const senderName = senderMember?.displayName || selectInteraction.user.globalName || selectInteraction.user.username;
                        const footerText = `By ; ${senderName}`;
                        const availableTextLength = 2000 - footerText.length - 2;
                        const trimmedWarningText = warningText.length > availableTextLength
                            ? warningText.slice(0, Math.max(availableTextLength - 1, 0)) + '…'
                            : warningText;
                        const dmContent = `${trimmedWarningText}${trimmedWarningText ? '\n\n' : ''}${footerText}`;
                        const dmFiles = attachments.map(attachment => ({
                            attachment: attachment.url,
                            name: attachment.name || 'image.png'
                        }));

                        collector.stop();

                        const progressEmbed = colorManager.createEmbed()
                            .setTitle('**جاري إرسال الرسالة للأعضاء...**')
                            .setDescription(`**✅ Done Send :** 0\n**❌ Failed :** 0\n**📨 Total :** ${selectedUserIds.length}`)
                            .setFooter({ text: footerText })
                            .setTimestamp();

                        await sentMessage.edit({ 
                            embeds: [progressEmbed],
                            components: [] 
                        });

                        let successCount = 0;
                        let failCount = 0;
                        let rateLimitedCount = 0;
                        let processedCount = 0;
                        const MAX_RETRIES = 3;

                        async function sleep(ms) {
                            return new Promise(resolve => setTimeout(resolve, ms));
                        }

                        async function sendDMWithRetry(user, payload, retries = MAX_RETRIES) {
                            for (let attempt = 0; attempt <= retries; attempt++) {
                                try {
                                    await user.send(payload);
                                    return { success: true };
                                } catch (error) {
                                    const retryAfter = Number(error.retry_after || error.retryAfter || error.rawError?.retry_after || 0);
                                    if (error.code === 429 || retryAfter > 0) {
                                        const waitMs = Math.ceil((retryAfter || (2 + attempt)) * 1000) + 500;
                                        console.warn(`⏳ Rate limit - انتظار ${waitMs}ms قبل إعادة المحاولة ${attempt + 1}/${retries}`);
                                        rateLimitedCount++;
                                        if (error.global) {
                                            globalBackoffUntil = Math.max(globalBackoffUntil, Date.now() + waitMs);
                                        }
                                        if (attempt < retries) {
                                            await sleep(waitMs);
                                            continue;
                                        }
                                        return { success: false, rateLimited: true };
                                    }
                                    if (error.code === 50007 || error.status === 403) {
                                        return { success: false, cannotDM: true };
                                    }
                                    if (attempt < retries && ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.code)) {
                                        await sleep(1500 * (attempt + 1));
                                        continue;
                                    }
                                    return { success: false, error: error.message };
                                }
                            }
                            return { success: false, error: 'unknown' };
                        }

                        let progressUpdateQueued = Promise.resolve();
                        let globalBackoffUntil = 0;
                        const DM_CONCURRENCY = Math.min(3, Math.max(1, selectedUserIds.length));

                        function queueProgressUpdate(force = false) {
                            if (!force && processedCount % 5 !== 0 && processedCount !== selectedUserIds.length) return;

                            progressUpdateQueued = progressUpdateQueued
                                .then(async () => {
                                    const updateEmbed = colorManager.createEmbed()
                                        .setTitle('**جاري إرسال الرسالة للأعضاء...**')
                                        .setDescription(`**✅ Done Send :** ${successCount}
**❌ Failed :** ${failCount}` +
                                            (rateLimitedCount > 0 ? `
**<:emoji_53:1430733925227171980> Rate Limited :** ${rateLimitedCount}` : '') +
                                            `
**📨 Progress :** ${processedCount}/${selectedUserIds.length}`)
                                        .setFooter({ text: footerText })
                                        .setTimestamp();
                                    await sentMessage.edit({ embeds: [updateEmbed] }).catch(() => {});
                                })
                                .catch(() => {});
                        }

                        async function waitForGlobalBackoff() {
                            const waitMs = globalBackoffUntil - Date.now();
                            if (waitMs > 0) {
                                await sleep(waitMs);
                            }
                        }

                        async function deliverToUser(userId) {
                            try {
                                await waitForGlobalBackoff();
                                const user = await client.users.fetch(userId);
                                const result = await sendDMWithRetry(user, { content: dmContent, files: dmFiles });

                                if (result.success) {
                                    successCount++;
                                    console.log(`✅ تم إرسال رسالة لـ ${user.tag}`);
                                } else {
                                    failCount++;
                                    console.error(`❌ فشل الإرسال - ${user.tag}: ${result.cannotDM ? 'DMs closed' : result.error || 'rate limited'}`);
                                }
                            } catch (error) {
                                failCount++;
                                console.error(`❌ فشل إرسال رسالة إلى ${userId}:`, error.message);
                            }

                            processedCount++;
                            queueProgressUpdate();
                        }

                        async function runWorker(workerId) {
                            for (let index = workerId; index < selectedUserIds.length; index += DM_CONCURRENCY) {
                                await deliverToUser(selectedUserIds[index]);
                            }
                        }

                        await Promise.all(Array.from({ length: DM_CONCURRENCY }, (_, workerId) => runWorker(workerId)));
                        queueProgressUpdate(true);
                        await progressUpdateQueued;


                        const colorNames = selectedColors.map(c => {
                            if (c === 'green') return 'Green <:emoji_11:1429246636936138823>';
                            if (c === 'yellow') return 'Yellow <:emoji_10:1429246610784653412>';
                            if (c === 'red') return 'Red <:emoji_9:1429246586289918063>';
                        }).join(', ');

                        const finalEmbed = colorManager.createEmbed()
                            .setTitle('**Done sended ✅️**')
                            .setDescription(`**✅ Done to :** ${successCount}\n**❌ Failed :** ${failCount}` +
                                (rateLimitedCount > 0 ? `\n**<:emoji_53:1430733925227171980> Rate Limited :** ${rateLimitedCount}` : '') +
                                `\n**Colors :** ${colorNames}\n**<:emoji_51:1430733172710183103> Final :** ${Math.round((successCount / Math.max(selectedUserIds.length, 1)) * 100)}%`)
                            .setFooter({ text: footerText })
                            .setTimestamp();

                        try {
                            await sentMessage.edit({ embeds: [finalEmbed] });
                        } catch (updateError) {
                            console.error('فشل تحديث الرسالة، سأرسل في القناة:', updateError.message);
                            await message.channel.send({ embeds: [finalEmbed] }).catch(() => {});
                        }
                    } catch (selectError) {
                        console.error('خطأ في انتظار اختيار المستلمين:', selectError);
                        await interaction.editReply({ 
                            content: '**❌ انتهت مهلة اختيار المستلمين**', 
                            components: [] 
                        }).catch(() => {});
                    }
                } catch (error) {
                    console.error('خطأ في إرسال رسائل check:', error);
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
    const guildId = message.guild?.id || null;

    try {
        const monthlyStats = await getActivityTotals(dbManager, guildId, user.id, monthStart.format('YYYY-MM-DD'));

        const voiceTime = (monthlyStats?.voiceTime || 0)
            + getLiveVoiceDuration(client, user.id, guildId, monthStart.valueOf());
        const messages = monthlyStats?.messages || 0;
        const xp = Math.floor(messages / 10);
        const colorEmoji = await getColorIndicator(user.id, client, dbManager, guildId);

        const voiceTimeFormatted = formatDuration(voiceTime);

        const embed = colorManager.createEmbed()
            .setTitle(` Check - ${user.globalName || user.username}`)
            .setDescription(`**Member :** <@${user.id}>\n${colorEmoji} **Voice :** **${voiceTimeFormatted}**\n**Chat :** **${xp}xp**`)
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

module.exports = { name, execute, buildActivitySource, getActivityTotals, getLiveVoiceDuration, getColorIndicator };
