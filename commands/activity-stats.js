const { EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { isUserBlocked } = require('./block.js');
const { isChannelBlocked } = require('./chatblock.js');
const { getDatabase } = require('../utils/database.js');
const moment = require('moment-timezone');

const name = 'تفاعلي';
const aliases = ['تواجدي', 'me'];

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

function getLiveVoiceDuration(userId, fromTimestamp) {
    if (global.client && global.client.voiceSessions && global.client.voiceSessions.has(userId)) {
        const session = global.client.voiceSessions.get(userId);
        if (session && !session.isAFK) {
            const liveStart = session.lastTrackedTime || session.startTime || session.sessionStartTime;
            const effectiveStart = Math.max(liveStart, fromTimestamp || 0);
            return Math.max(0, Date.now() - effectiveStart);
        }
    }
    return 0;
}

function buildActivityComponents(userId, activePeriod, isAfterSelected) {
    const buttonRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`activity_daily_${userId}`)
                .setLabel('Day')
                .setEmoji('<:emoji_50:1430788365069848596>')
                .setStyle(activePeriod === 'daily' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`activity_weekly_${userId}`)
                .setLabel('Week')
                .setEmoji('<:emoji_49:1430788330416640000>')
                .setStyle(activePeriod === 'weekly' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`activity_monthly_${userId}`)
                .setLabel('Month')
                .setEmoji('<:emoji_48:1430788303317368924>')
                .setStyle(activePeriod === 'monthly' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`activity_total_${userId}`)
                .setLabel('All')
                .setEmoji('<:emoji_22:1463536623730954376>')
                .setStyle(activePeriod === 'total' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        );

    const menuRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`activity_after_menu_${userId}`)
            .setPlaceholder('After Date')
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
        targetMember = await message.guild.members.fetch(targetUser.id);
    // لو كتب ID
    } else if (args[0]) {
        try {
            targetMember = await message.guild.members.fetch(args[0]);
            targetUser = targetMember.user;
        } catch (err) {
            return message.reply("❌ الآيدي غير صحيح أو العضو غير موجود");
        }
    }
    // إظهار الإحصائيات الشهرية بشكل افتراضي
    await showActivityStats(message, targetUser, targetMember, 'daily', client);
}

async function showActivityStats(message, user, member, period = 'weekly', client) {
    try {
        const dbManager = getDatabase();
        if (!dbManager || !dbManager.isInitialized) {
            await message.channel.send('❌ قاعدة البيانات غير متاحة');
            return;
        }

        let stats, periodLabel, activeDays;
        if (period === 'daily') {
            stats = await dbManager.getDailyStats(user.id);
            periodLabel = 'Daily Active';
            activeDays = stats.activeDays;
            // إضافة الوقت الحي لليومي
            const liveDuration = getLiveVoiceDuration(user.id, 0);
            stats.voiceTime = (stats.voiceTime || 0) + liveDuration;
        } else if (period === 'weekly') {
            stats = await dbManager.getWeeklyStats(user.id);
            const weeklyActiveDays = await dbManager.getWeeklyActiveDays(user.id);
            periodLabel = 'Weekly Active';
            activeDays = weeklyActiveDays;
            // إعادة تسمية المتغيرات للتناسق
            stats.voiceTime = stats.weeklyTime;
            stats.messages = stats.weeklyMessages;
            stats.reactions = stats.weeklyReactions;
            stats.voiceJoins = stats.weeklyVoiceJoins;
            // إضافة الوقت الحي للأسبوعي
            const liveDuration = getLiveVoiceDuration(user.id, 0);
            stats.voiceTime = (stats.voiceTime || 0) + liveDuration;
        } else if (period === 'monthly') {
            stats = await dbManager.getMonthlyStats(user.id);
            periodLabel = 'Monthly Active';
            activeDays = stats.activeDays;
            // إضافة تعويض للبيانات الشهرية
            stats.voiceTime = stats.voiceTime || 0;
            stats.messages = stats.messages || 0;
            stats.reactions = stats.reactions || 0;
            stats.voiceJoins = stats.voiceJoins || 0;
            // إضافة الوقت الحي للشهري
            const liveDuration = getLiveVoiceDuration(user.id, 0);
            stats.voiceTime = (stats.voiceTime || 0) + liveDuration;
        } else if (period === 'total') {
            // إحصائيات كليّة (غير قابلة للتصفير تلقائياً)
            const totals = await dbManager.getUserStats(user.id);
            stats = {
                voiceTime: totals.totalVoiceTime || 0,
                messages: totals.totalMessages || 0,
                reactions: totals.totalReactions || 0,
                voiceJoins: totals.totalVoiceJoins || 0
            };
            periodLabel = 'Total Active';
            // عدد أيام النشاط خلال السنة الماضية على الأقل
            activeDays = (await dbManager.getActiveDaysCount(user.id, 365)) || 0;
            // إضافة الوقت الحي للكلي
            const liveDuration = getLiveVoiceDuration(user.id, 0);
            stats.voiceTime = (stats.voiceTime || 0) + liveDuration;
        }

        // جلب أكثر قناة صوتية مع قيمة افتراضية
        const topVoiceChannel = await dbManager.getMostActiveVoiceChannel(user.id, period) || { channel_id: null, channel_name: 'No Data', total_time: 0, session_count: 0 };
        // جلب أكثر قناة رسائل مع قيمة افتراضية
        const topMessageChannel = await dbManager.getMostActiveMessageChannel(user.id) || { channel_id: null, channel_name: 'No Data', message_count: 0 };
        // حساب XP (10 رسائل = 1 XP)
        const xp = Math.floor((stats.messages || 0) / 10);
        // تحضير منشن القنوات
        const voiceChannelMention = topVoiceChannel?.channel_id ? `<#${topVoiceChannel.channel_id}>` : 'No Data';
        const messageChannelMention = topMessageChannel?.channel_id ? `<#${topMessageChannel.channel_id}>` : 'No Data';
        // إنشاء Embed مصغر
        const embed = colorManager.createEmbed()
            .setTitle(`${periodLabel}`)
            .setDescription(`**تفاعل ${member.displayName}**`)
            .setThumbnail(user.displayAvatarURL({ dynamic: true }))
            .addFields(
                { name: '# <:emoji_85:1442986413510627530> **Voice**', value: '** **', inline: false },
                { name: '**الوقت**', value: `**${formatDuration(stats.voiceTime || 0)}**`, inline: true },
                { name: '**جوينات**', value: `**${stats.voiceJoins || 0}**`, inline: true },
                { name: '**أكثر روم**', value: `${voiceChannelMention}`, inline: true },
                { name: '# <:emoji_85:1442986444712054954> **Chat**', value: '** **', inline: false },
                { name: '**رسائل**', value: `**${stats.messages || 0}**`, inline: true },
                { name: '**XP**', value: `**${xp}xp**`, inline: true },
                { name: '**رياكتات**', value: `**${stats.reactions || 0}**`, inline: true },
                { name: '**أكثر روم شات**', value: `${messageChannelMention}`, inline: false },
                { name: '**أيام التفاعل**', value: `**${activeDays || 0}${period === 'weekly' ? ' من 7' : ''}**`, inline: false }
            )
            .setFooter({ text: `${message.author.username}`, iconURL: message.author.displayAvatarURL() })
            .setTimestamp();
        const components = buildActivityComponents(user.id, period, false);
        const response = await message.channel.send({ embeds: [embed], components });
        // جمع التفاعلات على الأزرار
        const collector = response.createMessageComponentCollector({
            filter: i => (i.customId.startsWith('activity_') || i.customId === `activity_after_menu_${user.id}`) && i.user.id === message.author.id,
            time: 300000 // 5 دقائق
        });
        collector.on('collect', async interaction => {
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

                await interaction.showModal(modal);
                return;
            }
            const [, newPeriod, userId] = interaction.customId.split('_');
            if (userId !== user.id) return;
            try {
                // جلب الإحصائيات الجديدة
                let stats, periodLabel, activeDays;
                const liveDuration = getLiveVoiceDuration(user.id, 0);
                if (newPeriod === 'daily') {
                    stats = await dbManager.getDailyStats(user.id);
                    periodLabel = 'Daily Active';
                    activeDays = stats.activeDays;
                    // إضافة الوقت الحي
                    stats.voiceTime = (stats.voiceTime || 0) + liveDuration;
                } else if (newPeriod === 'weekly') {
                    stats = await dbManager.getWeeklyStats(user.id);
                    const weeklyActiveDays = await dbManager.getWeeklyActiveDays(user.id);
                    periodLabel = 'Weekly Active';
                    activeDays = weeklyActiveDays;
                    stats.voiceTime = stats.weeklyTime;
                    stats.messages = stats.weeklyMessages;
                    stats.reactions = stats.weeklyReactions;
                    stats.voiceJoins = stats.weeklyVoiceJoins;
                    // إضافة الوقت الحي
                    stats.voiceTime = (stats.voiceTime || 0) + liveDuration;
                } else if (newPeriod === 'monthly') {
                    stats = await dbManager.getMonthlyStats(user.id);
                    periodLabel = 'Monthly Active';
                    activeDays = stats.activeDays;
                    stats.voiceTime = stats.voiceTime || 0;
                    stats.messages = stats.messages || 0;
                    stats.reactions = stats.reactions || 0;
                    stats.voiceJoins = stats.voiceJoins || 0;
                    // إضافة الوقت الحي
                    stats.voiceTime = (stats.voiceTime || 0) + liveDuration;
                } else if (newPeriod === 'total') {
                    const totals = await dbManager.getUserStats(user.id);
                    stats = {
                        voiceTime: totals.totalVoiceTime || 0,
                        messages: totals.totalMessages || 0,
                        reactions: totals.totalReactions || 0,
                        voiceJoins: totals.totalVoiceJoins || 0
                    };
                    periodLabel = 'Total Active';
                    activeDays = (await dbManager.getActiveDaysCount(user.id, 365)) || 0;
                    stats.voiceTime = (stats.voiceTime || 0) + liveDuration;
                }
                const topVoiceChannel = await dbManager.getMostActiveVoiceChannel(user.id, newPeriod) || { channel_id: null, channel_name: 'No Active Or Leave Channel', total_time: 0, session_count: 0 };
                const topMessageChannel = await dbManager.getMostActiveMessageChannel(user.id) || { channel_id: null, channel_name: 'No Active In Chat', message_count: 0 };
                const xp = Math.floor((stats.messages || 0) / 10);
                const voiceChannelMention = topVoiceChannel?.channel_id ? `<#${topVoiceChannel.channel_id}>` : 'No Active Or Leave Channel';
                const messageChannelMention = topMessageChannel?.channel_id ? `<#${topMessageChannel.channel_id}>` : 'No Active In Chat';
                // إنشاء الإمبد المحدث
                const updatedEmbed = colorManager.createEmbed()
                    .setTitle(`${periodLabel}`)
                    .setDescription(`**تفاعل ${member.displayName}**`)
                    .setThumbnail(user.displayAvatarURL({ dynamic: true }))
                    .addFields(
                        { name: '# <:emoji_85:1442986413510627530> **Voice**', value: '** **', inline: false },
                        { name: '**الوقت**', value: `**${formatDuration(stats.voiceTime || 0)}**`, inline: true },
                        { name: '**جوينات**', value: `**${stats.voiceJoins || 0}**`, inline: true },
                        { name: '**أكثر روم**', value: `${voiceChannelMention}`, inline: true },
                        { name: '# <:emoji_85:1442986444712054954> **Chat**', value: '** **', inline: false },
                        { name: '**رسائل**', value: `**${stats.messages || 0}**`, inline: true },
                        { name: '**XP**', value: `**${xp}xp**`, inline: true },
                        { name: '**رياكتات**', value: `**${stats.reactions || 0}**`, inline: true },
                        { name: '**أكثر روم شات**', value: `${messageChannelMention}`, inline: false },
                        { name: '**أيام التفاعل**', value: `**${activeDays || 0}${newPeriod === 'weekly' ? ' من 7' : ''}**`, inline: false }
                    )
                    .setFooter({ text: `${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
                    .setTimestamp();
                // تحديث الأزرار مع زر "All"
                // تحديث الرسالة
                await interaction.update({ embeds: [updatedEmbed], components: buildActivityComponents(user.id, newPeriod, false) });
            } catch (error) {
                console.error('خطأ في تحديث الإحصائيات:', error);
            }
        });
        collector.on('end', () => {
            response.edit({ components: [] }).catch(() => {});
        });
    } catch (error) {
        console.error('❌ خطأ في عرض إحصائيات التفاعل:', error);
        await message.channel.send('❌ حدث خطأ أثناء جلب الإحصائيات');
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

        const fromDate = dateMoment.format('YYYY-MM-DD');
        const fromTimestamp = dateMoment.valueOf();
        const activityTotals = await dbManager.get(`
            SELECT SUM(messages) as messages,
                   SUM(reactions) as reactions
            FROM daily_activity
            WHERE user_id = ? AND date >= ?
        `, [targetUserId, fromDate]);

        const voiceSessionStats = await dbManager.get(`
            SELECT SUM(duration) as voiceTime,
                   COUNT(*) as voiceJoins
            FROM voice_sessions
            WHERE user_id = ? AND start_time >= ?
        `, [targetUserId, fromTimestamp]);
        let voiceTime = voiceSessionStats?.voiceTime || 0;

        const liveDuration = getLiveVoiceDuration(targetUserId, fromTimestamp);
        voiceTime += liveDuration;

        const messages = activityTotals?.messages || 0;
        const reactions = activityTotals?.reactions || 0;
        const voiceJoins = voiceSessionStats?.voiceJoins || 0;
        const noActivity = !messages && !reactions && !voiceJoins && !voiceTime;

        let memberDisplay = targetUserId;
        if (interaction.guild) {
            try {
                const member = await interaction.guild.members.fetch(targetUserId);
                memberDisplay = member.displayName;
            } catch (error) {}
        }

        const activeDaysResult = await dbManager.get(`
            SELECT COUNT(DISTINCT date) as count
            FROM daily_activity
            WHERE user_id = ?
            AND date >= ?
            AND (voice_time > 0 OR messages > 0 OR reactions > 0 OR voice_joins > 0)
        `, [targetUserId, fromDate]);
        const activeDays = activeDaysResult?.count || 0;

        const topVoiceChannel = await dbManager.get(`
            SELECT channel_id, channel_name, SUM(duration) as total_time, COUNT(*) as session_count
            FROM voice_sessions
            WHERE user_id = ? AND start_time >= ?
            GROUP BY channel_id
            ORDER BY total_time DESC
            LIMIT 1
        `, [targetUserId, fromTimestamp]) || { channel_id: null, channel_name: 'No Data', total_time: 0, session_count: 0 };

        const voiceChannelMention = topVoiceChannel?.channel_id ? `<#${topVoiceChannel.channel_id}>` : 'No Data';
        const topMessageChannel = await dbManager.get(`
            SELECT channel_id, channel_name, message_count, last_message
            FROM message_channels
            WHERE user_id = ? AND last_message >= ?
            ORDER BY message_count DESC
            LIMIT 1
        `, [targetUserId, fromTimestamp]) || { channel_id: null, channel_name: 'No Data', message_count: 0 };
        const messageChannelMention = topMessageChannel?.channel_id ? `<#${topMessageChannel.channel_id}>` : 'No Data';
        const xp = Math.floor((messages || 0) / 10);

        const summaryEmbed = colorManager.createEmbed()
            .setTitle('After Date')
            .setDescription(`**تفاعل ${memberDisplay}**\n**من :** ${dateMoment.format('YYYY-MM-DD hh:mm A')} ${noActivity ? '\n**لا يوجد نشاط مسجل بعد هذا التاريخ.**' : ''}`)
            .addFields(
                { name: '# <:emoji_85:1442986413510627530> **Voice**', value: '** **', inline: false },
                { name: '**الوقت**', value: `**${formatDuration(voiceTime)}**`, inline: true },
                { name: '**جوينات**', value: `**${voiceJoins}**`, inline: true },
                { name: '**أكثر روم**', value: `${voiceChannelMention}`, inline: true },
                { name: '# <:emoji_85:1442986444712054954> **Chat**', value: '** **', inline: false },
                { name: '**رسائل**', value: `**${messages}**`, inline: true },
                { name: '**XP**', value: `**${xp}xp**`, inline: true },
                { name: '**رياكتات**', value: `**${reactions}**`, inline: true },
                { name: '**أكثر روم شات**', value: `${messageChannelMention}`, inline: false },
                { name: '**أيام التفاعل**', value: `**${activeDays}**`, inline: false }
            )
            .setTimestamp();

        await interaction.deferReply({ ephemeral: true });
        try {
            const targetMessage = await interaction.channel.messages.fetch(targetMessageId);
            await targetMessage.edit({ embeds: [summaryEmbed], components: buildActivityComponents(targetUserId, null, true) });
            await interaction.editReply({ content: '✅ تم تحديث الإحصائيات بعد التاريخ.' });
        } catch (error) {
            await interaction.editReply({ content: '⚠️ تعذر تحديث الرسالة الأصلية، لكن تم إنشاء النتائج هنا.' });
            await interaction.followUp({ embeds: [summaryEmbed], ephemeral: true });
        }
    }
};
