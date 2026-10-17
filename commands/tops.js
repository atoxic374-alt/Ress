const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { isUserBlocked } = require('./block.js');
const { isChannelBlocked } = require('./chatblock.js');
const { getDatabase } = require('../utils/database.js');
const moment = require('moment-timezone');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { buildTopSummaryImage } = require('../utils/topSummaryRenderer.js');
const { getGuildBannerHex } = require('../utils/guildBannerColor.js');

const name = 'توب';

const { getDatabasePath } = require('../utils/storagePaths');
const streakDbPath = getDatabasePath('streak.db');
const TOP_CACHE_TTL_MS = 15 * 1000;
const topResultsCache = new Map();
let streakDb = null;

function invalidateTopsCache(guildId = null) {
    if (!guildId) {
        topResultsCache.clear();
        return;
    }
    const prefix = `${String(guildId)}:`;
    for (const key of topResultsCache.keys()) {
        if (key.startsWith(prefix)) topResultsCache.delete(key);
    }
}

function pruneTopResultsCache(now = Date.now()) {
    for (const [key, entry] of topResultsCache) {
        if (!entry || now - entry.createdAt >= TOP_CACHE_TTL_MS) topResultsCache.delete(key);
    }
    if (topResultsCache.size > 500) {
        const oldest = [...topResultsCache.entries()]
            .sort((a, b) => a[1].createdAt - b[1].createdAt)
            .slice(0, topResultsCache.size - 500);
        for (const [key] of oldest) topResultsCache.delete(key);
    }
}

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

async function getTopUsers(db, category, period, limit = 50, guildId = null) {
    try {
        const cacheKey = `${String(guildId || 'global')}:${category}:${period}:${limit}`;
        const cacheNow = Date.now();
        pruneTopResultsCache(cacheNow);
        const cached = topResultsCache.get(cacheKey);
        if (cached && cacheNow - cached.createdAt < TOP_CACHE_TTL_MS) return cached.rows;
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
        const activitySource = guildId
            ? `(SELECT user_id, date, voice_time, messages, reactions, voice_joins FROM guild_daily_activity WHERE guild_id = ?
               UNION ALL SELECT user_id, date, voice_time, messages, reactions, voice_joins FROM daily_activity)`
            : 'daily_activity';

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
                    FROM ${activitySource}
                    WHERE voice_time > 0 ${dateFilter}
                    GROUP BY user_id
                    ORDER BY value DESC
                    LIMIT ?
                `;
                params = guildId ? [guildId, ...params, limit] : [...params, limit];
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
                    FROM ${activitySource}
                    WHERE messages > 0 ${dateFilter}
                    GROUP BY user_id
                    ORDER BY value DESC
                    LIMIT ?
                `;
                params = guildId ? [guildId, ...params, limit] : [...params, limit];
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
                    FROM ${activitySource}
                    WHERE reactions > 0 ${dateFilter}
                    GROUP BY user_id
                    ORDER BY value DESC
                    LIMIT ?
                `;
                params = guildId ? [guildId, ...params, limit] : [...params, limit];
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
                    FROM ${activitySource}
                    WHERE voice_joins > 0 ${dateFilter}
                    GROUP BY user_id
                    ORDER BY value DESC
                    LIMIT ?
                `;
                params = guildId ? [guildId, ...params, limit] : [...params, limit];
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
            const rows = updatedResults.sort((a, b) => b.value - a.value).slice(0, limit || 50);
            topResultsCache.set(cacheKey, { rows, createdAt: cacheNow });
            return rows;
        }
        topResultsCache.set(cacheKey, { rows: results, createdAt: cacheNow });
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

    const bannerAccentColor = await getGuildBannerHex(
        message.guild,
        colorManager.getColor?.() || '#5865F2'
    );

    let currentCategory = null; // null means initial view (voice + chat)
    let currentPeriod = 'monthly';
    let currentPage = 0;
    const pageSize = 10;
    const topNameCache = new Map();
    let allMembersFetchPromise = null;
    async function getTopDisplayName(userId) {
        const normalizedId = String(userId);
        if (topNameCache.has(normalizedId)) return topNameCache.get(normalizedId);
        const cachedMember = message.guild.members.cache.get(normalizedId);
        if (cachedMember?.displayName) {
            topNameCache.set(normalizedId, cachedMember.displayName);
            return cachedMember.displayName;
        }
        const fetchedMember = await message.guild.members.fetch({ user: normalizedId, force: true }).catch(() => null);
        if (fetchedMember?.displayName) {
            topNameCache.set(normalizedId, fetchedMember.displayName);
            return fetchedMember.displayName;
        }
        const cachedUser = client.users.cache.get(normalizedId);
        if (cachedUser?.globalName || cachedUser?.username) {
            const name = cachedUser.globalName || cachedUser.username;
            topNameCache.set(normalizedId, name);
            return name;
        }
        const fetchedUser = await client.users.fetch(normalizedId, { force: true }).catch(() => null);
        if (fetchedUser?.globalName || fetchedUser?.username) {
            const name = fetchedUser.globalName || fetchedUser.username;
            topNameCache.set(normalizedId, name);
            return name;
        }
        // محاولة أخيرة من قائمة أعضاء السيرفر لمعالجة حالات الكاش أو مشاكل الـ gateway.
        if (!allMembersFetchPromise) allMembersFetchPromise = message.guild.members.fetch().catch(() => null);
        const allMembers = await allMembersFetchPromise;
        const recoveredMember = allMembers?.get(normalizedId);
        const recoveredName = recoveredMember?.displayName || recoveredMember?.user?.globalName || recoveredMember?.user?.username;
        if (recoveredName) {
            topNameCache.set(normalizedId, recoveredName);
            return recoveredName;
        }
        return 'Unknown Member';
    }

    function formatRankValue(category, value) {
        if (category === 'voice') return formatDuration(value);
        if (category === 'chat') return `${Math.floor(value / 10)}xp`;
        if (category === 'reactions') return `${value}R`;
        if (category === 'joins') return `${value}J`;
        return String(value);
    }

    async function getYourRank(category, period) {
        // العرض يبقى 5/10، لكن حساب رتبة العضو يبحث في كامل القائمة حتى لو كان #100 أو أبعد.
        const rows = await getTopUsers(db, category, period, 100000, message.guild.id);
        const rankIndex = rows.findIndex(row => String(row.user_id) === String(message.author.id));
        if (rankIndex === -1) return 'Your Rank :  Unranked';
        return `Your Rank :  #${rankIndex + 1}  •  ${formatRankValue(category, rows[rankIndex].value)}`;
    }

    async function buildInitialImage() {
        const topVoice = await getTopUsers(db, 'voice', currentPeriod, 5, message.guild.id);
        const topChat = await getTopUsers(db, 'chat', currentPeriod, 5, message.guild.id);
        const [voiceRank, chatRank] = await Promise.all([
            getYourRank('voice', currentPeriod),
            getYourRank('chat', currentPeriod)
        ]);
        const periodNames = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', total: 'All' };
        const showSeconds = shouldShowSeconds(topVoice);
        return buildTopSummaryImage({
            accentColor: bannerAccentColor,
            title: 'Rank',
            subtitle: `${periodNames[currentPeriod]} • Voice and Chat Leaderboard`,
            sections: [
                { title: 'Top Voice', rows: topVoice.length ? await Promise.all(topVoice.map(async (user, idx) => ({
                    label: `#${idx + 1}  ${await getTopDisplayName(user.user_id)}`, value: formatDuration(user.value, showSeconds)
                }))) : [{ label: 'No data', value: '—' }] },
                { title: 'Top Chat', rows: topChat.length ? await Promise.all(topChat.map(async (user, idx) => ({
                    label: `#${idx + 1}  ${await getTopDisplayName(user.user_id)}`, value: `${Math.floor(user.value / 10)}xp`
                }))) : [{ label: 'No data', value: '—' }] }
            ],
            yourRank: `${voiceRank.replace('Your Rank :  ', 'Voice :  ')}   |   ${chatRank.replace('Your Rank :  ', 'Chat :  ')}`
        });
    }

    async function buildStreakImage() {
        const isEnabled = await isStreakSystemEnabled(message.guild.id);
        if (!isEnabled) {
            return buildTopSummaryImage({ accentColor: bannerAccentColor, title: 'Streak', subtitle: 'Top Streak', sections: [{ title: 'Status', rows: [{ label: 'System', value: 'Not enabled' }] }], yourRank: 'Your Rank :  Unranked' });
        }
        const allStreaks = await getStreakUsers(message.guild.id);
        if (!allStreaks.length) {
            return buildTopSummaryImage({ accentColor: bannerAccentColor, title: 'Top Streak', subtitle: 'No active streaks', sections: [{ title: 'Status', rows: [{ label: 'Members', value: 'No data' }] }], yourRank: 'Your Rank :  Unranked' });
        }
        const totalPages = Math.ceil(allStreaks.length / pageSize);
        const startIndex = currentPage * pageSize;
        const pageStreaks = allStreaks.slice(startIndex, startIndex + pageSize);
        const today = moment().tz('Asia/Riyadh').format('YYYY-MM-DD');
        const myStreakIndex = allStreaks.findIndex(streak => String(streak.user_id) === String(message.author.id));
        const myStreak = myStreakIndex === -1
            ? 'Your Rank :  Unranked'
            : `Your Rank :  #${myStreakIndex + 1}  •  ${allStreaks[myStreakIndex].current_streak} days`;
        return buildTopSummaryImage({
            accentColor: bannerAccentColor,
            title: 'Top Streak',
            subtitle: `Page ${currentPage + 1} of ${totalPages}`,
            sections: [{ title: 'Streaks', rows: await Promise.all(pageStreaks.map(async (streak, index) => ({
                label: `#${startIndex + index + 1}  ${await getTopDisplayName(streak.user_id)}`,
                value: `${streak.current_streak} ${streak.last_post_date === today ? 'Active' : 'Not Active'}`
            }))) }],
            yourRank: myStreak
        });
    }

    async function buildCategoryImage() {
        const categoryPageSize = 10;
        const topUsers = await getTopUsers(db, currentCategory, currentPeriod, 100, message.guild.id);
        const categoryNames = { voice: 'Top Voice', chat: 'Top Chat', reactions: 'Reactions', joins: 'Joins' };
        const periodNames = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', total: 'All' };
        if (!topUsers.length) {
            return buildTopSummaryImage({ accentColor: bannerAccentColor, title: categoryNames[currentCategory] || 'Top', subtitle: `${periodNames[currentPeriod]} • No data`, sections: [{ title: 'Status', rows: [{ label: 'Results', value: 'No data' }] }], yourRank: 'Your Rank :  Unranked' });
        }
        const totalPages = Math.ceil(topUsers.length / categoryPageSize);
        const startIndex = currentPage * categoryPageSize;
        const pageUsers = topUsers.slice(startIndex, startIndex + categoryPageSize);
        const yourRank = await getYourRank(currentCategory, currentPeriod);
        const showSeconds = currentCategory === 'voice' && shouldShowSeconds(pageUsers);
        const rows = await Promise.all(pageUsers.map(async (user, index) => {
            let value = user.value;
            if (currentCategory === 'voice') value = formatDuration(user.value, showSeconds);
            else if (currentCategory === 'chat') value = `${Math.floor(user.value / 10)}xp`;
            else if (currentCategory === 'reactions') value = `${user.value}R`;
            else if (currentCategory === 'joins') value = `${user.value}J`;
            return { label: `#${startIndex + index + 1}  ${await getTopDisplayName(user.user_id)}`, value };
        }));
        return buildTopSummaryImage({
            accentColor: bannerAccentColor,
            title: categoryNames[currentCategory] || 'Top',
            subtitle: `${periodNames[currentPeriod]} • Page ${currentPage + 1} of ${totalPages}`,
            sections: [{ title: categoryNames[currentCategory] || 'Top', rows }],
            yourRank
        });
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
            const categoryPageSize = 10;
            const topUsers = await getTopUsers(db, currentCategory, currentPeriod, 100, message.guild.id);
            totalPages = Math.ceil(topUsers.length / categoryPageSize);
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

    const initialImage = await buildInitialImage();
    const initialButtons = await buildButtons();
    const sentMessage = await message.channel.send({ files: [initialImage], components: initialButtons });

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
                    const categoryPageSize = 10;
                    const topUsers = await getTopUsers(db, currentCategory, currentPeriod, 100, message.guild.id);
                    totalPages = Math.ceil(topUsers.length / categoryPageSize);
                }
                if (currentPage < totalPages - 1) {
                    currentPage++;
                }
            }

            let newImage;
            if (currentCategory === null) {
                newImage = await buildInitialImage();
            } else if (currentCategory === 'streaks') {
                newImage = await buildStreakImage();
            } else {
                newImage = await buildCategoryImage();
            }
            
            const newButtons = await buildButtons();

            await interaction.update({ files: [newImage], components: newButtons });
        } catch (error) {
            console.error('Error in tops collector:', error);
        }
    });

    collector.on('end', () => {
        sentMessage.edit({ components: [] }).catch(() => {});
    });
}

module.exports = { name, execute, invalidateTopsCache, getTopUsers };
