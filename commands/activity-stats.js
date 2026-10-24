const { EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { isUserBlocked } = require('./block.js');
const { isChannelBlocked } = require('./chatblock.js');
const { getDatabase } = require('../utils/database.js');
const moment = require('moment-timezone');
const { buildTopSummaryImage } = require('../utils/topSummaryRenderer.js');
const { getGuildBannerHexFast } = require('../utils/guildBannerColor.js');
const topsCommand = require('./tops.js');
const { getActivityPeriodStart, getLiveVoiceDuration: getSharedLiveVoiceDuration } = require('../utils/activityTime.js');

const name = 'تفاعلي';
const aliases = ['تواجدي', 'me'];
const ACTIVITY_CACHE_TTL_MS = 15 * 1000;
const activityCache = new Map();
const activityUpdateQueues = new Map();
function enqueueActivityUpdate(messageId, operation) {
    const key = String(messageId);
    const previous = activityUpdateQueues.get(key) || Promise.resolve();
    const queued = previous.catch(() => {}).then(operation);
    activityUpdateQueues.set(key, queued);
    queued.then(
        () => { if (activityUpdateQueues.get(key) === queued) activityUpdateQueues.delete(key); },
        () => { if (activityUpdateQueues.get(key) === queued) activityUpdateQueues.delete(key); }
    );
    return queued;
}

function getActivityCacheKey(guildId, userId, period) {
    return `${guildId || 'global'}:${userId}:${period}`;
}

function invalidateActivityCache(guildId = null, userId = null) {
    if (!guildId && !userId) return activityCache.clear();
    for (const key of activityCache.keys()) {
        if ((!guildId || key.startsWith(`${guildId}:`)) && (!userId || key.includes(`:${userId}:`))) activityCache.delete(key);
    }
}

function pruneActivityCache(now = Date.now()) {
    for (const [key, entry] of activityCache) {
        if (!entry || now - entry.createdAt >= ACTIVITY_CACHE_TTL_MS) activityCache.delete(key);
    }
    if (activityCache.size > 500) {
        const oldest = [...activityCache.entries()]
            .sort((a, b) => a[1].createdAt - b[1].createdAt)
            .slice(0, activityCache.size - 500);
        for (const [key] of oldest) activityCache.delete(key);
    }
}

function formatRankValue(category, value) {
    if (category === 'voice') return formatDuration(value);
    return `${Math.floor(Number(value || 0) / 10)}xp`;
}

async function getActivityRanks(db, period, userId, guildId, voiceTimeValue = null) {
    const [voiceResult, chatResult] = await Promise.all([
        topsCommand.getUserRank(db, 'voice', period, userId, guildId),
        topsCommand.getUserRank(db, 'chat', period, userId, guildId)
    ]);
    return {
        voice: !voiceResult.rank ? 'Unranked' : `#${voiceResult.rank}  •  ${formatRankValue('voice', Number.isFinite(voiceTimeValue) ? voiceTimeValue : voiceResult.value)}`,
        chat: !chatResult.rank ? 'Unranked' : `#${chatResult.rank}  •  ${formatRankValue('chat', chatResult.value)}`
    };
}
async function buildActivityImage({ message, member, period, periodLabel, stats, activeDays, db, accentColor }) {
    const guildId = message.guild?.id;
    const cacheKey = `${getActivityCacheKey(guildId, member.id, period)}:${Math.floor(Number(stats.voiceTime || 0) / 60000)}:${stats.messages || 0}:${stats.reactions || 0}:${stats.voiceJoins || 0}:${activeDays || 0}`;
    const now = Date.now();
    pruneActivityCache(now);
    const cached = activityCache.get(cacheKey);
    if (cached && now - cached.createdAt < ACTIVITY_CACHE_TTL_MS) return cached.image;
    const [ranks, topVoiceChannel = {}, topMessageChannel = {}] = await Promise.all([
        getActivityRanks(db, period, member.id, guildId, Number(stats.voiceTime || 0)),
        db.getMostActiveVoiceChannel(member.id, period, guildId),
        db.getMostActiveMessageChannel(member.id, guildId)
    ]);
    const voiceChannel = topVoiceChannel.channel_name && topVoiceChannel.channel_name !== 'unknown'
        ? `#${topVoiceChannel.channel_name}` : 'No Data';
    const messageChannel = topMessageChannel.channel_name && topMessageChannel.channel_name !== 'unknown'
        ? `#${topMessageChannel.channel_name}` : 'No Data';
    const image = buildTopSummaryImage({
        accentColor,
        title: periodLabel,
        subtitle: `Activity for ${member.displayName}`,
        sections: [{
            title: 'Voice',
            rows: [
                { label: 'Time', value: formatDuration(stats.voiceTime || 0) },
                { label: 'Joins', value: String(stats.voiceJoins || 0) },
                { label: 'Most Active Room', value: voiceChannel }
            ]
        }, {
            title: 'Chat',
            rows: [
                { label: 'Messages', value: String(stats.messages || 0) },
                { label: 'XP', value: `${Math.floor((stats.messages || 0) / 10)}xp` },
                { label: 'Reactions', value: String(stats.reactions || 0) },
                { label: 'Most Active Chat', value: messageChannel },
                { label: 'Active Days', value: `${activeDays || 0}${period === 'weekly' ? ' of 7' : ''}` }
            ]
        }],
        yourRank: `Voice :  ${ranks.voice}   |   Chat :  ${ranks.chat}`
    });
    activityCache.set(cacheKey, { image, createdAt: now });
    return image;
}

function formatDuration(milliseconds) {
    if (!milliseconds || milliseconds <= 0) return '0';

    const totalSeconds = Math.floor(milliseconds / 1000);
    const totalMinutes = Math.floor(totalSeconds / 60);
    const totalHours = Math.floor(totalMinutes / 60);
    const days = Math.floor(totalHours / 24);

    const hours = totalHours % 24;
    const minutes = totalMinutes % 60;

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);

    return parts.length > 0 ? parts.join(' and ') : 'أقل من دقيقة';
}

function formatChannelDisplay(channelData, guild, emptyText = 'لا يوجد') {
    if (!channelData?.channel_id) return emptyText;
    const channel = guild?.channels?.cache?.get(channelData.channel_id);
    if (channel) return `<#${channel.id}>`;
    const safeName = String(channelData.channel_name || '').trim();
    return safeName && safeName.toLowerCase() !== 'unknown' ? `#${safeName}` : 'قناة غير متاحة';
}

function parseTimeInput(value) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return { hour: 0, minute: 0 };
    const match = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!match) return null;
    let hour = parseInt(match[1], 10);
    const minute = match[2] ? parseInt(match[2], 10) : 0;
    const meridiem = match[3] ? match[3].toLowerCase() : null;
    if (Number.isNaN(hour) || Number.isNaN(minute) || minute < 0 || minute > 59) return null;
    if (meridiem) {
        if (hour < 1 || hour > 12) return null;
        if (meridiem === 'pm' && hour !== 12) hour += 12;
        if (meridiem === 'am' && hour === 12) hour = 0;
    } else if (hour > 23) {
        return null;
    }
    return { hour, minute };
}

function getLiveVoiceDuration(userId, fromTimestamp = 0, now = Date.now()) {
    return getSharedLiveVoiceDuration(global.client, userId, fromTimestamp, now);
}

function buildActivityComponents(userId, activePeriod, isAfterSelected, disabled = false) {
    const buttonRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`activity_daily_${userId}`)
                .setLabel('Day')
                .setEmoji('<:emoji_50:1430788365069848596>')
                .setStyle(activePeriod === 'daily' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(disabled),
            new ButtonBuilder()
                .setCustomId(`activity_weekly_${userId}`)
                .setLabel('Week')
                .setEmoji('<:emoji_49:1430788330416640000>')
                .setStyle(activePeriod === 'weekly' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(disabled),
            new ButtonBuilder()
                .setCustomId(`activity_monthly_${userId}`)
                .setLabel('Month')
                .setEmoji('<:emoji_48:1430788303317368924>')
                .setStyle(activePeriod === 'monthly' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(disabled),
            new ButtonBuilder()
                .setCustomId(`activity_total_${userId}`)
                .setLabel('All')
                .setEmoji('<:emoji_22:1463536623730954376>')
                .setStyle(activePeriod === 'total' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(disabled)
        );

    const menuRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`activity_after_menu_${userId}`)
            .setPlaceholder('After Date')
            .setDisabled(disabled)
            .addOptions(
                {
                    label: 'After Date',
                    value: 'after',
                    emoji: '<:emoji_19:1457493164826034186>',
                    default: Boolean(isAfterSelected)
                }
            )
    );

    return [buttonRow, menuRow];
}

async function execute(message, args, { client }) {
    if (isChannelBlocked(message.channel.id)) {
        return;
    }

    if (isUserBlocked(message.author.id)) {
        const blockedEmbed = colorManager.createEmbed()
            .setDescription('**🚫 أنت محظور من استخدام أوامر البوت**\n**للاستفسار، تواصل مع إدارة السيرفر**')
            .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

        await message.channel.send({ embeds: [blockedEmbed] });
        return;
    }

    // التحقق من المنشن
    let targetUser = message.author;
    let targetMember = message.member;

    // لو كتب منشن
    if (message.mentions.users.size > 0) {
        targetUser = message.mentions.users.first();
        targetMember = message.guild.members.cache.get(targetUser.id)
            || await message.guild.members.fetch({ user: targetUser.id }).catch(() => null);
        if (!targetMember) return message.reply("❌ العضو غير موجود في السيرفر");
    // لو كتب ID
    } else if (args[0]) {
        try {
            targetMember = message.guild.members.cache.get(args[0])
                || await message.guild.members.fetch({ user: args[0] }).catch(() => null);
            if (!targetMember) throw new Error('member_not_found');
            targetUser = targetMember.user;
        } catch (err) {
            return message.reply("❌ الآيدي غير صحيح أو العضو غير موجود");
        }
    }
    // إظهار الإحصائيات الشهرية بشكل افتراضي
    await showActivityStats(message, targetUser, targetMember, 'daily', client);
}

async function showActivityStats(message, user, member, period = 'weekly', client) {
    let progressMessage = null;
    try {
        const dbManager = getDatabase();
        if (!dbManager || !dbManager.isInitialized) {
            await message.channel.send('❌ قاعدة البيانات غير متاحة');
            return;
        }
        const bannerAccentColor = getGuildBannerHexFast(message.guild, colorManager.getColor?.() || '#5865F2');
        progressMessage = await message.channel.send('جارٍ تجهيز إحصائياتك...');

        let stats, periodLabel, activeDays;
        const guildId = message.guild?.id;
        const liveNow = Date.now();
        const livePeriodStart = getActivityPeriodStart(period, liveNow);
        const getPeriodStats = async selectedPeriod => {
            const rows = await dbManager.getPeriodActivityStats(selectedPeriod, user.id, guildId);
            return rows[0] || { voiceTime: 0, messages: 0, reactions: 0, voiceJoins: 0 };
        };
        if (period === 'daily') {
            const [periodStats, metadata] = await Promise.all([
                getPeriodStats('daily'),
                dbManager.getDailyStats(user.id, guildId)
            ]);
            stats = periodStats;
            periodLabel = 'Daily Active';
            activeDays = metadata.activeDays;
        } else if (period === 'weekly') {
            const [periodStats, weeklyActiveDays] = await Promise.all([
                getPeriodStats('weekly'),
                dbManager.getWeeklyActiveDays(user.id, guildId)
            ]);
            stats = periodStats;
            periodLabel = 'Weekly Active';
            activeDays = weeklyActiveDays;
        } else if (period === 'monthly') {
            const [periodStats, metadata] = await Promise.all([
                getPeriodStats('monthly'),
                dbManager.getMonthlyStats(user.id, guildId)
            ]);
            stats = periodStats;
            periodLabel = 'Monthly Active';
            activeDays = metadata.activeDays;
        } else if (period === 'total') {
            const [periodStats, totalActiveDays] = await Promise.all([
                getPeriodStats('total'),
                dbManager.getActiveDaysCount(user.id, 365, guildId)
            ]);
            stats = periodStats;
            periodLabel = 'Total Active';
            activeDays = totalActiveDays || 0;
        }
        stats.voiceTime = (stats.voiceTime || 0) + getLiveVoiceDuration(user.id, livePeriodStart, liveNow);

        const activityImage = await buildActivityImage({ message, member, period, periodLabel, stats, activeDays, db: dbManager, accentColor: bannerAccentColor });
        const response = await progressMessage.edit({ content: '', files: [activityImage], components: buildActivityComponents(user.id, period, false) });
        // جمع التفاعلات على الأزرار
        const collector = response.createMessageComponentCollector({
            filter: i => (i.customId.startsWith('activity_') || i.customId === `activity_after_menu_${user.id}`) && i.user.id === message.author.id,
            time: 300000 // 5 دقائق
        });
        let isUpdatingActivity = false;
        let selectedActivityPeriod = period;
        collector.on('collect', interaction => {
            if (isUpdatingActivity) {
                void interaction.deferUpdate().catch(error => console.error('تعذر إقرار النقرة الإضافية:', error));
                return;
            }
            if (interaction.customId === `activity_after_menu_${user.id}`) {
                const currentYear = moment().tz('Asia/Riyadh').year();
                const modal = new ModalBuilder()
                    .setCustomId(`activity_after_date_modal_${user.id}_${message.author.id}_${response.id}`)
                    .setTitle('بعد تاريخ محدد');

                const monthInput = new TextInputBuilder()
                    .setCustomId('after_date_month')
                    .setLabel('الشهر (1-12)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setPlaceholder('مثال: 9');

                const dayInput = new TextInputBuilder()
                    .setCustomId('after_date_day')
                    .setLabel('اليوم (1-31)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setPlaceholder('مثال: 25');

                const yearInput = new TextInputBuilder()
                    .setCustomId('after_date_year')
                    .setLabel('السنة')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setValue(String(currentYear));

                const timeInput = new TextInputBuilder()
                    .setCustomId('after_date_time')
                    .setLabel('الوقت (اختياري) مثل 10pm أو 9am')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setPlaceholder('اتركه فارغًا لبدء اليوم');

                modal.addComponents(
                    new ActionRowBuilder().addComponents(monthInput),
                    new ActionRowBuilder().addComponents(dayInput),
                    new ActionRowBuilder().addComponents(yearInput),
                    new ActionRowBuilder().addComponents(timeInput)
                );

                void interaction.showModal(modal).catch(error => console.error('تعذر فتح نموذج التاريخ:', error));
                return;
            }
            const acknowledged = interaction.deferUpdate()
                .then(() => true)
                .catch(error => {
                    console.error('تعذر إقرار تفاعل تواجدي:', error);
                    return false;
                });
            isUpdatingActivity = true;
            void enqueueActivityUpdate(response.id, async () => {
                const previousPeriod = selectedActivityPeriod;
                try {
                    if (!(await acknowledged)) return;
                    const [, newPeriod, clickedUserId] = interaction.customId.split('_');
                    if (clickedUserId !== user.id || !['daily', 'weekly', 'monthly', 'total'].includes(newPeriod)) return;
                    await response.edit({ components: buildActivityComponents(user.id, selectedActivityPeriod, false, true) });
                    // جلب الإحصائيات الجديدة
                    let stats, periodLabel, activeDays;
                    const liveNow = Date.now();
                    const guildId = interaction.guild?.id;
                    const livePeriodStart = getActivityPeriodStart(newPeriod, liveNow);
                    const getPeriodStats = async selectedPeriod => {
                        const rows = await dbManager.getPeriodActivityStats(selectedPeriod, user.id, guildId);
                        return rows[0] || { voiceTime: 0, messages: 0, reactions: 0, voiceJoins: 0 };
                    };
                    if (newPeriod === 'daily') {
                        const [periodStats, metadata] = await Promise.all([
                            getPeriodStats('daily'),
                            dbManager.getDailyStats(user.id, guildId)
                        ]);
                        stats = periodStats;
                        periodLabel = 'Daily Active';
                        activeDays = metadata.activeDays;
                    } else if (newPeriod === 'weekly') {
                        const [periodStats, weeklyActiveDays] = await Promise.all([
                            getPeriodStats('weekly'),
                            dbManager.getWeeklyActiveDays(user.id, guildId)
                        ]);
                        stats = periodStats;
                        periodLabel = 'Weekly Active';
                        activeDays = weeklyActiveDays;
                    } else if (newPeriod === 'monthly') {
                        const [periodStats, metadata] = await Promise.all([
                            getPeriodStats('monthly'),
                            dbManager.getMonthlyStats(user.id, guildId)
                        ]);
                        stats = periodStats;
                        periodLabel = 'Monthly Active';
                        activeDays = metadata.activeDays;
                    } else if (newPeriod === 'total') {
                        const [periodStats, totalActiveDays] = await Promise.all([
                            getPeriodStats('total'),
                            dbManager.getActiveDaysCount(user.id, 365, guildId)
                        ]);
                        stats = periodStats;
                        periodLabel = 'Total Active';
                        activeDays = totalActiveDays || 0;
                    }
                    stats.voiceTime = (stats.voiceTime || 0) + getLiveVoiceDuration(user.id, livePeriodStart, liveNow);
                    invalidateActivityCache(message.guild?.id, user.id);
                    topsCommand.invalidateTopsCache(message.guild?.id);
                    const activityImage = await buildActivityImage({ message, member, period: newPeriod, periodLabel, stats, activeDays, db: dbManager, accentColor: bannerAccentColor });
                    await response.edit({ files: [activityImage], components: buildActivityComponents(user.id, newPeriod, false, true) });
                    selectedActivityPeriod = newPeriod;
                    await response.edit({ components: buildActivityComponents(user.id, selectedActivityPeriod, false, false) });
                } catch (error) {
                    selectedActivityPeriod = previousPeriod;
                    console.error('خطأ في تحديث الإحصائيات:', error);
                    await response.edit({ components: buildActivityComponents(user.id, selectedActivityPeriod, false, false) }).catch(() => {});
                } finally {
                    isUpdatingActivity = false;
                }
            }).catch(error => {
                isUpdatingActivity = false;
                console.error('تعذر إكمال تحديث تواجدي:', error);
            });
        });
        collector.on('end', () => {
            void enqueueActivityUpdate(response.id, () => response.edit({ components: [] })).catch(() => {});
        });
    } catch (error) {
        console.error('❌ خطأ في عرض إحصائيات التفاعل:', error);
        if (progressMessage) await progressMessage.edit('❌ حدث خطأ أثناء جلب الإحصائيات').catch(() => {});
        else await message.channel.send('❌ حدث خطأ أثناء جلب الإحصائيات');
    }
}

module.exports = {
    name,
    aliases,
    execute,
    async handleModalSubmit(interaction, client) {
        if (!interaction.customId.startsWith('activity_after_date_modal_')) return;
        const modalParts = interaction.customId.split('_');
        const targetUserId = modalParts[4];
        const requesterId = modalParts[5];
        const targetMessageId = modalParts[6];
        if (!targetUserId || !requesterId || !targetMessageId) {
            await interaction.reply({ content: '❌ نموذج غير صالح.', ephemeral: true });
            return;
        }
        if (interaction.user.id !== requesterId) {
            await interaction.reply({ content: '❌ لا يمكنك استخدام هذا النموذج.', ephemeral: true });
            return;
        }

        const monthInput = interaction.fields.getTextInputValue('after_date_month').trim();
        const dayInput = interaction.fields.getTextInputValue('after_date_day').trim();
        const yearInput = interaction.fields.getTextInputValue('after_date_year').trim();
        const timeInput = interaction.fields.getTextInputValue('after_date_time').trim();

        const month = parseInt(monthInput, 10);
        const day = parseInt(dayInput, 10);
        const year = parseInt(yearInput, 10);
        if (!month || month < 1 || month > 12) {
            await interaction.reply({ content: '❌ الشهر غير صحيح. أدخل رقم بين 1 و 12.', ephemeral: true });
            return;
        }
        if (!day || day < 1 || day > 31) {
            await interaction.reply({ content: '❌ اليوم غير صحيح. أدخل رقم بين 1 و 31.', ephemeral: true });
            return;
        }
        if (!year || year < 1970 || year > 3000) {
            await interaction.reply({ content: '❌ السنة غير صحيحة.', ephemeral: true });
            return;
        }

        const timeParts = timeInput ? parseTimeInput(timeInput) : { hour: 0, minute: 0 };
        if (!timeParts) {
            await interaction.reply({ content: '❌ صيغة الوقت غير صحيحة. مثال: 10pm أو 9am أو 14:30.', ephemeral: true });
            return;
        }

        const dateMoment = moment.tz({ year, month: month - 1, day, hour: timeParts.hour, minute: timeParts.minute }, 'Asia/Riyadh');
        if (!dateMoment.isValid() || dateMoment.month() !== month - 1 || dateMoment.date() !== day) {
            await interaction.reply({ content: '❌ التاريخ غير صحيح. تحقق من اليوم والشهر.', ephemeral: true });
            return;
        }

        const dbManager = getDatabase();
        if (!dbManager || !dbManager.isInitialized) {
            await interaction.reply({ content: '❌ قاعدة البيانات غير متاحة حالياً.', ephemeral: true });
            return;
        }

        await interaction.deferReply({ ephemeral: true });
        const fromDate = dateMoment.format('YYYY-MM-DD');
        const fromTimestamp = dateMoment.valueOf();
        const guildId = interaction.guild?.id;
        const activityTable = guildId
            ? `(SELECT date, voice_time, messages, reactions, voice_joins FROM guild_daily_activity WHERE guild_id = ? AND user_id = ?
               UNION ALL SELECT date, voice_time, messages, reactions, voice_joins FROM daily_activity WHERE user_id = ?)`
            : 'daily_activity';
        const activityScope = '1 = 1';
        const activityParams = guildId ? [guildId, targetUserId, targetUserId, fromDate] : [targetUserId, fromDate];
        const voiceScope = guildId ? '(guild_id = ? OR guild_id IS NULL) AND user_id = ?' : 'user_id = ?';
        const voiceParams = guildId ? [guildId, targetUserId, fromTimestamp] : [targetUserId, fromTimestamp];
        const [activityTotals, voiceSessionStats, activeDaysResult, ranks, memberDisplay] = await Promise.all([
            dbManager.get(`
                SELECT SUM(messages) as messages, SUM(reactions) as reactions
                FROM ${activityTable}
                WHERE ${activityScope} AND date >= ?
            `, activityParams),
            dbManager.get(`
                SELECT SUM(duration) as voiceTime, COUNT(*) as voiceJoins
                FROM voice_sessions
                WHERE ${voiceScope} AND start_time >= ?
            `, voiceParams),
            dbManager.get(`
                SELECT COUNT(DISTINCT date) as count
                FROM ${activityTable}
                WHERE ${activityScope} AND date >= ?
                AND (voice_time > 0 OR messages > 0 OR reactions > 0 OR voice_joins > 0)
            `, activityParams),
            getActivityRanks(dbManager, 'total', targetUserId, interaction.guild?.id),
            (async () => {
                if (!interaction.guild) return targetUserId;
                const member = interaction.guild.members.cache.get(targetUserId)
                    || await interaction.guild.members.fetch({ user: targetUserId }).catch(() => null);
                return member?.displayName || targetUserId;
            })()
        ]);
        let voiceTime = voiceSessionStats?.voiceTime || 0;
        voiceTime += getLiveVoiceDuration(targetUserId, fromTimestamp);
        const messages = activityTotals?.messages || 0;
        const reactions = activityTotals?.reactions || 0;
        const voiceJoins = voiceSessionStats?.voiceJoins || 0;
        const noActivity = !messages && !reactions && !voiceJoins && !voiceTime;
        const activeDays = activeDaysResult?.count || 0;

        const bannerAccentColor = getGuildBannerHexFast(interaction.guild, colorManager.getColor?.() || '#5865F2');
        const summaryImage = buildTopSummaryImage({
            accentColor: bannerAccentColor,
            title: 'After Date',
            subtitle: `Activity for ${memberDisplay} • From ${dateMoment.format('YYYY-MM-DD hh:mm A')}`,
            sections: [{ title: 'Voice', rows: [
                { label: 'Time', value: formatDuration(voiceTime) },
                { label: 'Joins', value: String(voiceJoins) }
            ] }, { title: 'Chat', rows: [
                { label: 'Messages', value: String(messages) },
                { label: 'XP', value: `${Math.floor(messages / 10)}xp` },
                { label: 'Reactions', value: String(reactions) },
                { label: 'Active Days', value: String(activeDays) }
            ] }],
            yourRank: `Voice :  ${ranks.voice}   |   Chat :  ${ranks.chat}`
        });

        try {
            await enqueueActivityUpdate(targetMessageId, async () => {
                const targetMessage = await interaction.channel.messages.fetch(targetMessageId);
                await targetMessage.edit({ files: [summaryImage], components: buildActivityComponents(targetUserId, null, true) });
            });
            await interaction.editReply({ content: '✅ تم تحديث الإحصائيات بعد التاريخ.' });
        } catch (error) {
            await interaction.editReply({ content: '⚠️ تعذر تحديث الرسالة الأصلية، لكن تم إنشاء النتائج هنا.' });
            await interaction.followUp({ files: [summaryImage], components: buildActivityComponents(targetUserId, null, true), ephemeral: true });
        }
    }
};
