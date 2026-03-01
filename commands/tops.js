const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { isUserBlocked } = require('./block.js');
const { isChannelBlocked } = require('./chatblock.js');
const { getDatabase } = require('../utils/database.js');
const moment = require('moment-timezone');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const name = 'توب';

const streakDbPath = path.join(__dirname, '..', 'database', 'streak.db');
let streakDb = null;

function initializeStreakDatabase() {
    return new Promise((resolve, reject) => {
        const dbDir = path.dirname(streakDbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        streakDb = new sqlite3.Database(streakDbPath, async (err) => {
            if (err) {
                console.error('خطأ في فتح قاعدة بيانات streak:', err);
                return reject(err);
            }
            console.log('✅ تم فتح قاعدة بيانات Streak في tops');
            
            // إنشاء الجداول إذا لم تكن موجودة
            try {
                await streakRunQuery(`CREATE TABLE IF NOT EXISTS streak_settings (
                    guild_id TEXT PRIMARY KEY,
                    approver_type TEXT,
                    approver_targets TEXT,
                    locked_channel_id TEXT,
                    divider_image_url TEXT,
                    reaction_emojis TEXT
                )`);

                await streakRunQuery(`CREATE TABLE IF NOT EXISTS streak_users (
                    guild_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    current_streak INTEGER DEFAULT 0,
                    longest_streak INTEGER DEFAULT 0,
                    last_post_date TEXT,
                    total_posts INTEGER DEFAULT 0,
                    is_active BOOLEAN DEFAULT 1,
                    created_at INTEGER DEFAULT (strftime('%s', 'now')),
                    PRIMARY KEY (guild_id, user_id)
                )`);

                await streakRunQuery(`CREATE TABLE IF NOT EXISTS streak_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    guild_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    message_id TEXT,
                    post_date TEXT NOT NULL,
                    streak_count INTEGER,
                    created_at INTEGER DEFAULT (strftime('%s', 'now'))
                )`);

                await streakRunQuery(`CREATE TABLE IF NOT EXISTS streak_restore_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    guild_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    previous_streak INTEGER,
                    request_message TEXT,
                    status TEXT DEFAULT 'pending',
                    approver_id TEXT,
                    created_at INTEGER DEFAULT (strftime('%s', 'now')),
                    resolved_at INTEGER
                )`);

                await streakRunQuery(`CREATE TABLE IF NOT EXISTS streak_dividers (
                    guild_id TEXT NOT NULL,
                    channel_id TEXT NOT NULL,
                    message_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    user_message_ids TEXT,
                    created_at INTEGER DEFAULT (strftime('%s', 'now'))
                )`);

                console.log('✅ تم التحقق من جداول Streak في tops');
                resolve();
            } catch (tableError) {
                console.error('❌ خطأ في إنشاء جداول Streak:', tableError);
                reject(tableError);
            }
        });
    });
}

function streakRunQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        if (!streakDb) {
            return reject(new Error('قاعدة البيانات غير مهيأة'));
        }
        streakDb.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function streakAllQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        if (!streakDb) {
            return reject(new Error('قاعدة البيانات غير مهيأة'));
        }
        streakDb.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function streakGetQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        if (!streakDb) {
            return reject(new Error('قاعدة البيانات غير مهيأة'));
        }
        streakDb.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function formatDuration(milliseconds, showSeconds = false) {
    if (!milliseconds || milliseconds <= 0) return 'لا يوجد';

    const totalSeconds = Math.floor(milliseconds / 1000);
    const totalMinutes = Math.floor(totalSeconds / 60);
    const totalHours = Math.floor(totalMinutes / 60);
    const days = Math.floor(totalHours / 24);

    const hours = totalHours % 24;
    const minutes = totalMinutes % 60;
    const seconds = totalSeconds % 60;

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || showSeconds) parts.push(`${minutes}m`);
    if (showSeconds && seconds > 0) parts.push(`${seconds}s`);

    return parts.length > 0 ? parts.join(' and ') : 'أقل من دقيقة';
}

function shouldShowSeconds(users) {
    // Check if there are duplicate minute values
    const minuteValues = users.map(u => Math.floor(u.value / 60000));
    const hasDuplicates = minuteValues.some((val, idx) => minuteValues.indexOf(val) !== idx);
    return hasDuplicates;
}

async function getTopUsers(db, category, period, limit = 50) {
    try {
        const now = moment().tz('Asia/Riyadh');
        const nowMs = now.valueOf();
        let dateFilter = '';
        let params = [];
        let periodStartMs = null;

        if (period === 'daily') {
            const today = now.format('YYYY-MM-DD');
            dateFilter = 'AND date = ?';
            params.push(today);
            periodStartMs = now.clone().startOf('day').valueOf();
        } else if (period === 'weekly') {
            const weekStart = now.clone().startOf('week').format('YYYY-MM-DD');
            dateFilter = 'AND date >= ?';
            params.push(weekStart);
            periodStartMs = now.clone().startOf('week').valueOf();
        } else if (period === 'monthly') {
            const monthStart = now.clone().startOf('month').format('YYYY-MM-DD');
            dateFilter = 'AND date >= ?';
            params.push(monthStart);
            periodStartMs = now.clone().startOf('month').valueOf();
        }

        let query = '';

        if (category === 'voice') {
            if (period === 'total') {
                query = `
                    SELECT user_id, total_voice_time as value
                    FROM user_totals
                    WHERE total_voice_time > 0
                    ORDER BY total_voice_time DESC
                    LIMIT ?
                `;
                params = [limit];
            } else {
                query = `
                    SELECT user_id, SUM(voice_time) as value
                    FROM daily_activity
                    WHERE voice_time > 0 ${dateFilter}
                    GROUP BY user_id
                    ORDER BY value DESC
                    LIMIT ?
                `;
                params.push(limit);
            }
        } else if (category === 'chat') {
            if (period === 'total') {
                query = `
                    SELECT user_id, total_messages as value
                    FROM user_totals
                    WHERE total_messages > 0
                    ORDER BY total_messages DESC
                    LIMIT ?
                `;
                params = [limit];
            } else {
                query = `
                    SELECT user_id, SUM(messages) as value
                    FROM daily_activity
                    WHERE messages > 0 ${dateFilter}
                    GROUP BY user_id
                    ORDER BY value DESC
                    LIMIT ?
                `;
                params.push(limit);
            }
        } else if (category === 'reactions') {
            if (period === 'total') {
                query = `
                    SELECT user_id, total_reactions as value
                    FROM user_totals
                    WHERE total_reactions > 0
                    ORDER BY total_reactions DESC
                    LIMIT ?
                `;
                params = [limit];
            } else {
                query = `
                    SELECT user_id, SUM(reactions) as value
                    FROM daily_activity
                    WHERE reactions > 0 ${dateFilter}
                    GROUP BY user_id
                    ORDER BY value DESC
                    LIMIT ?
                `;
                params.push(limit);
            }
        } else if (category === 'joins') {
            if (period === 'total') {
                query = `
                    SELECT user_id, total_voice_joins as value
                    FROM user_totals
                    WHERE total_voice_joins > 0
                    ORDER BY total_voice_joins DESC
                    LIMIT ?
                `;
                params = [limit];
            } else {
                query = `
                    SELECT user_id, SUM(voice_joins) as value
                    FROM daily_activity
                    WHERE voice_joins > 0 ${dateFilter}
                    GROUP BY user_id
                    ORDER BY value DESC
                    LIMIT ?
                `;
                params.push(limit);
            }
        }

        let results = await db.all(query, params);
        results = results || [];

        // إضافة الوقت الحي للفويس في الترتيب (اليومي والأسبوعي والشهري والكلي)
        if (category === 'voice' && global.client && global.client.voiceSessions) {
            const updatedResults = [...results];
            
            for (const [userId, session] of global.client.voiceSessions.entries()) {
                let liveDuration = 0;
                if (!session.isAFK) {
                    const liveStart = session.lastTrackedTime || session.startTime || session.sessionStartTime || nowMs;
                    const effectiveStart = periodStartMs ? Math.max(liveStart, periodStartMs) : liveStart;
                    liveDuration = Math.max(0, nowMs - effectiveStart);
                }
                const existingUser = updatedResults.find(r => r.user_id === userId);
                
                if (existingUser) {
                    existingUser.value = (existingUser.value || 0) + liveDuration;
                } else {
                    updatedResults.push({ user_id: userId, value: liveDuration });
                }
            }

            // إعادة الترتيب لضمان الدقة بعد الإضافة اللحظية
            return updatedResults.sort((a, b) => b.value - a.value).slice(0, limit || 50);
        }

        return results;
    } catch (error) {
        console.error('خطأ في جلب أفضل المستخدمين:', error);
        return [];
    }
}

async function getStreakUsers(guildId) {
    try {
        if (!streakDb) {
            await initializeStreakDatabase();
        }

        const allStreaks = await streakAllQuery(`
            SELECT * FROM streak_users 
            WHERE guild_id = ? AND current_streak > 0 
            ORDER BY current_streak DESC, last_post_date ASC
        `, [guildId]);
        
        return allStreaks || [];
    } catch (error) {
        if (error.code === 'SQLITE_ERROR' && error.message.includes('no such table')) {
            return [];
        }
        console.error('خطأ في جلب بيانات Streaks:', error);
        return [];
    }
}

async function isStreakSystemEnabled(guildId) {
    try {
        if (!streakDb) {
            await initializeStreakDatabase();
        }

        const settings = await streakGetQuery('SELECT * FROM streak_settings WHERE guild_id = ?', [guildId]);
        return settings !== undefined && settings !== null;
    } catch (error) {
        if (error.code === 'SQLITE_ERROR' && error.message.includes('no such table')) {
            return false;
        }
        console.error('خطأ في فحص نظام Streaks:', error);
        return false;
    }
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

    const db = getDatabase();
    if (!db || !db.isInitialized) {
        await message.channel.send('❌ قاعدة البيانات غير متاحة');
        return;
    }

    let currentCategory = null; // null means initial view (voice + chat)
    let currentPeriod = 'monthly';
    let currentPage = 0;
    const pageSize = 10;

    async function buildInitialEmbed() {
        const topVoice = await getTopUsers(db, 'voice', currentPeriod, 5);
        const topChat = await getTopUsers(db, 'chat', currentPeriod, 5);

        const periodNames = {
            daily: 'Daily',
            weekly: 'Weekly',
            monthly: 'Monthly',
            total: 'All'
        };

        const embed = colorManager.createEmbed()
            .setTitle('**Rank**')
            .setTimestamp()
            .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

        let description = '';

        // Voice section
        description += '**top voice :**\n';
        if (topVoice.length === 0) {
            description += 'لا توجد بيانات\n';
        } else {
            const showSeconds = shouldShowSeconds(topVoice);
            description += topVoice.map((user, idx) => {
                const rank = idx + 1;
                const time = formatDuration(user.value, showSeconds);
                return `**#${rank}** - <@${user.user_id}> : **${time}**`;
            }).join('\n') + '\n';
        }

        description += '\n**top chat :**\n';
        if (topChat.length === 0) {
            description += 'لا توجد بيانات';
        } else {
            description += topChat.map((user, idx) => {
                const rank = idx + 1;
                const xp = Math.floor(user.value / 10);
                return `**#${rank}** - <@${user.user_id}> : **${xp}xp**`;
            }).join('\n');
        }

        embed.setDescription(description)
            .setFooter({ text: `${periodNames[currentPeriod]}` });

        return embed;
    }

    async function buildStreakEmbed() {
        const isEnabled = await isStreakSystemEnabled(message.guild.id);
        
        const embed = colorManager.createEmbed()
            .setTimestamp()
            .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

        if (!isEnabled) {
            embed.setTitle('**نظام Streak غير مُفعّل**')
                .setDescription('** يرجى التواصل مع المسؤولين لتفعيله **')
                .setFooter({ text: 'الصفحة 1 من 1' });
            return embed;
        }

        const allStreaks = await getStreakUsers(message.guild.id);

        if (allStreaks.length === 0) {
            embed.setTitle('**Rank Streak**')
                .setDescription('لا يوجد أحد لديه Streak حالياً!\n\n**كن أول من يبدأ**')
                .setFooter({ text: 'الصفحة 1 من 1' });
            return embed;
        }

        const totalPages = Math.ceil(allStreaks.length / pageSize);
        const startIndex = currentPage * pageSize;
        const endIndex = Math.min(startIndex + pageSize, allStreaks.length);
        const pageStreaks = allStreaks.slice(startIndex, endIndex);

        const today = moment().tz('Asia/Riyadh').format('YYYY-MM-DD');
        let description = '';
        
        for (let i = 0; i < pageStreaks.length; i++) {
            const streak = pageStreaks[i];
            const globalRank = startIndex + i + 1;
            const isActiveToday = streak.last_post_date === today;
            const statusEmoji = isActiveToday ? '<:emoji_64:1442587855447654522>' : '<:emoji_63:1442587778964525077>';
            const fireEmojis = '🔥'.repeat(Math.min(Math.floor(streak.current_streak / 5) + 1, 3));
            
            description += `**#${globalRank} -** <@${streak.user_id}> **${streak.current_streak}** Status : ${statusEmoji}\n`;
        }

        embed.setTitle('**Top Streak**')
            .setDescription(description.trim())
            .addFields([
                { name: '\u200b', value: '<:emoji_63:1442587778964525077> Active  •  <:emoji_64:1442587855447654522> Not Active', inline: false }
            ])
            .setFooter({ text: `الصفحة ${currentPage + 1} من ${totalPages} • إجمالي ${allStreaks.length} عضو ؛` });
        
        return embed;
    }

    async function buildCategoryEmbed() {
        const topUsers = await getTopUsers(db, currentCategory, currentPeriod, 100);
        
        const categoryNames = {
            voice: 'Voice',
            chat: 'chat',
            reactions: 'Reactions',
            joins: 'Joins'
        };

        const periodNames = {
            daily: 'Daily',
            weekly: 'Weekly',
            monthly: 'Monthly',
            total: 'All'
        };

        const embed = colorManager.createEmbed()
            .setTimestamp()
            .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

        if (topUsers.length === 0) {
            embed.setTitle(`**${categoryNames[currentCategory]}**`)
                .setDescription('**لا توجد بيانات في هذه الفترة**')
                .setFooter({ text: `${periodNames[currentPeriod]} • الصفحة 1 من 1` });
            return embed;
        }

        const totalPages = Math.ceil(topUsers.length / pageSize);
        const startIndex = currentPage * pageSize;
        const endIndex = Math.min(startIndex + pageSize, topUsers.length);
        const pageUsers = topUsers.slice(startIndex, endIndex);

        let description = '';
        
        if (currentCategory === 'voice') {
            embed.setTitle(`*top voice*`);
            const showSeconds = shouldShowSeconds(pageUsers);
            description = pageUsers.map((user, idx) => {
                const rank = startIndex + idx + 1;
                const time = formatDuration(user.value, showSeconds);
                return `**#${rank}** - <@${user.user_id}> : **${time}**`;
            }).join('\n');
        } else if (currentCategory === 'chat') {
            embed.setTitle(`*top chat*`);
            description = pageUsers.map((user, idx) => {
                const rank = startIndex + idx + 1;
                const xp = Math.floor(user.value / 10);
                return `**#${rank}** - <@${user.user_id}> : **${xp}xp**`;
            }).join('\n');
        } else if (currentCategory === 'reactions') {
            embed.setTitle(`*Reactions*`);
            description = pageUsers.map((user, idx) => {
                const rank = startIndex + idx + 1;
                return `**#${rank}** - <@${user.user_id}> : **${user.value}R**`;
            }).join('\n');
        } else if (currentCategory === 'joins') {
            embed.setTitle(`*Joins*`);
            description = pageUsers.map((user, idx) => {
                const rank = startIndex + idx + 1;
                return `**#${rank}** - <@${user.user_id}> : **${user.value}J**`;
            }).join('\n');
        }

        embed.setDescription(description)
            .setFooter({ text: `${periodNames[currentPeriod]} • الصفحة ${currentPage + 1} من ${totalPages}` });

        return embed;
    }

    const categorySelect = new StringSelectMenuBuilder()
        .setCustomId('tops_category_select')
        .setPlaceholder('اختر القسم...')
        .addOptions([
            { label: 'voice', value: 'voice', description: 'توب الفويس', emoji: '<:emoji_94:1443104810089054239>' },
            { label: 'chat', value: 'chat', description: 'توب الشات', emoji: '<:emoji_17:1429266743309893682>' },
            { label: 'reactions', value: 'reactions', description: 'توب الرياكتات', emoji: '<:emoji_19:1429266802239602830>' },
            { label: 'joins', value: 'joins', description: 'توب الجوين فويس', emoji: '<:emoji_53:1430791989959594094>' },
            { label: 'Streaks', value: 'streaks', description: 'توب الستريك', emoji: '<:emoji_59:1442587611574308884>' }
        ]);

    const selectRow = new ActionRowBuilder().addComponents(categorySelect);

    async function buildButtons() {
        const isStreakCategory = currentCategory === 'streaks';
        
        const periodRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('tops_daily')
                .setLabel('Day')
                .setEmoji('<:emoji_53:1430788459630563418>')
                .setStyle(currentPeriod === 'daily' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(isStreakCategory),
            new ButtonBuilder()
                .setCustomId('tops_weekly')
                .setLabel('Week')
                .setEmoji('<:emoji_51:1430788420891840585>')
                .setStyle(currentPeriod === 'weekly' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(isStreakCategory),
            new ButtonBuilder()
                .setCustomId('tops_monthly')
                .setLabel('Month')
                .setEmoji('<:emoji_50:1430788392018382909>')
                .setStyle(currentPeriod === 'monthly' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(isStreakCategory),
            new ButtonBuilder()
                .setCustomId('tops_total')
                .setLabel('All')
                .setEmoji('<:emoji_22:1463536623730954376>')
                .setStyle(currentPeriod === 'total' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(isStreakCategory)
        );

        if (currentCategory === null) {
            return [selectRow, periodRow];
        }

        let totalPages;
        if (isStreakCategory) {
            const allStreaks = await getStreakUsers(message.guild.id);
            totalPages = Math.ceil(allStreaks.length / pageSize);
        } else {
            const topUsers = await getTopUsers(db, currentCategory, currentPeriod, 100);
            totalPages = Math.ceil(topUsers.length / pageSize);
        }

        if (totalPages <= 1) {
            return [selectRow, periodRow];
        }

        const navigationRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('tops_prev')
                .setEmoji('<:emoji_13:1429263136136888501>')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage === 0),
            new ButtonBuilder()
                .setCustomId('tops_next')
                .setEmoji('<:emoji_14:1429263186539974708>')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage >= totalPages - 1)
        );

        return [selectRow, periodRow, navigationRow];
    }

    const initialEmbed = await buildInitialEmbed();
    const initialButtons = await buildButtons();
    const sentMessage = await message.channel.send({ 
        embeds: [initialEmbed], 
        components: initialButtons 
    });

    const filter = i => i.user.id === message.author.id && i.message.id === sentMessage.id;
    const collector = message.channel.createMessageComponentCollector({ filter, time: 600000 });

    collector.on('collect', async interaction => {
        try {
            if (interaction.customId === 'tops_category_select') {
                currentCategory = interaction.values[0];
                currentPage = 0;
            } else if (interaction.customId === 'tops_daily') {
                currentPeriod = 'daily';
                currentPage = 0;
            } else if (interaction.customId === 'tops_weekly') {
                currentPeriod = 'weekly';
                currentPage = 0;
            } else if (interaction.customId === 'tops_monthly') {
                currentPeriod = 'monthly';
                currentPage = 0;
            } else if (interaction.customId === 'tops_total') {
                currentPeriod = 'total';
                currentPage = 0;
            } else if (interaction.customId === 'tops_prev' && currentPage > 0) {
                currentPage--;
            } else if (interaction.customId === 'tops_next') {
                let totalPages;
                if (currentCategory === 'streaks') {
                    const allStreaks = await getStreakUsers(message.guild.id);
                    totalPages = Math.ceil(allStreaks.length / pageSize);
                } else {
                    const topUsers = await getTopUsers(db, currentCategory, currentPeriod, 100);
                    totalPages = Math.ceil(topUsers.length / pageSize);
                }
                if (currentPage < totalPages - 1) {
                    currentPage++;
                }
            }

            let newEmbed;
            if (currentCategory === null) {
                newEmbed = await buildInitialEmbed();
            } else if (currentCategory === 'streaks') {
                newEmbed = await buildStreakEmbed();
            } else {
                newEmbed = await buildCategoryEmbed();
            }
            
            const newButtons = await buildButtons();

            await interaction.update({ 
                embeds: [newEmbed], 
                components: newButtons 
            });
        } catch (error) {
            console.error('Error in tops collector:', error);
        }
    });

    collector.on('end', () => {
        sentMessage.edit({ components: [] }).catch(() => {});
    });
}

module.exports = { name, execute };
