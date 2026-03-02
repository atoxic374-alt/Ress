const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits, ChannelType, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder, AttachmentBuilder } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { logEvent } = require('../utils/logs_system.js');
const { createPaginatedResponsibilityArray, handlePaginationInteraction } = require('../utils/responsibilityPagination.js');
const fs = require('fs');
const path = require('path');
const schedule = require('node-schedule');
const moment = require('moment-timezone');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');

const name = 'streak';

const dbPath = path.join(__dirname, '..', 'database', 'streak.db');
const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');

let db = null;
const warnedGuilds = new Set();
const REACTION_SEARCH_HISTORY_LIMIT = 80;
const FOLLOWER_NOTIFY_MAX_PER_POST = 60;
const FOLLOWER_NOTIFY_BATCH_SIZE = 8;
const FOLLOWER_NOTIFY_BATCH_DELAY_MS = 1200;
const IGNORABLE_DISCORD_ERROR_CODES = new Set([10003, 10008, 50001, 50013]);

function getDiscordErrorCode(error) {
    if (!error) return null;
    const directCode = typeof error.code === 'number' ? error.code : Number(error.code);
    if (!Number.isNaN(directCode) && Number.isFinite(directCode)) {
        return directCode;
    }

    const nestedCode = typeof error.rawError?.code === 'number'
        ? error.rawError.code
        : Number(error.rawError?.code);
    if (!Number.isNaN(nestedCode) && Number.isFinite(nestedCode)) {
        return nestedCode;
    }

    return null;
}

function isIgnorableDiscordError(error) {
    const code = getDiscordErrorCode(error);
    return code !== null && IGNORABLE_DISCORD_ERROR_CODES.has(code);
}

async function safeDeleteMessage(message, contextLabel = 'message') {
    if (!message || typeof message.delete !== 'function') {
        return false;
    }

    try {
        await message.delete();
        return true;
    } catch (error) {
        if (isIgnorableDiscordError(error)) {
            console.log(`ℹ️ تخطّي حذف ${contextLabel}: ${error.message}`);
            return false;
        }

        throw error;
    }
}


function initializeDatabase() {
    return new Promise((resolve, reject) => {
        const dbDir = path.dirname(dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        db = new sqlite3.Database(dbPath, async (err) => {
            if (err) {
                console.error('خطأ في فتح قاعدة بيانات streak:', err);
                return reject(err);
            }

            try {
                // إعداد PRAGMA
                await runQuery('PRAGMA journal_mode=WAL');
                await runQuery('PRAGMA synchronous=NORMAL');

                // إنشاء الجداول بالترتيب مع الانتظار
                await runQuery(`CREATE TABLE IF NOT EXISTS streak_settings (
                    guild_id TEXT PRIMARY KEY,
                    approver_type TEXT,
                    approver_targets TEXT,
                    locked_channel_id TEXT,
                    divider_image_url TEXT,
                    reaction_emojis TEXT
                )`);

                await runQuery(`CREATE TABLE IF NOT EXISTS streak_users (
                    guild_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    current_streak INTEGER DEFAULT 0,
                    longest_streak INTEGER DEFAULT 0,
                    last_post_date TEXT,
                    total_posts INTEGER DEFAULT 0,
                    is_active BOOLEAN DEFAULT 1,
                    PRIMARY KEY (guild_id, user_id)
                )`);

                await runQuery(`CREATE TABLE IF NOT EXISTS streak_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    guild_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    message_id TEXT,
                    post_date TEXT NOT NULL,
                    streak_count INTEGER,
                    image_local_path TEXT,
                    created_at INTEGER DEFAULT (strftime('%s', 'now'))
                )`);

                await runQuery('ALTER TABLE streak_history ADD COLUMN image_local_path TEXT').catch(() => {});

                await runQuery(`CREATE TABLE IF NOT EXISTS streak_restore_requests (
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

                await runQuery(`CREATE TABLE IF NOT EXISTS streak_dividers (
                    guild_id TEXT NOT NULL,
                    channel_id TEXT NOT NULL,
                    message_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    user_message_ids TEXT
                )`);

                await runQuery(`CREATE TABLE IF NOT EXISTS streak_followers (
                    guild_id TEXT NOT NULL,
                    target_user_id TEXT NOT NULL,
                    follower_user_id TEXT NOT NULL,
                    is_anonymous INTEGER DEFAULT 1,
                    is_active INTEGER DEFAULT 1,
                    created_at INTEGER DEFAULT (strftime('%s', 'now')),
                    updated_at INTEGER DEFAULT (strftime('%s', 'now')),
                    PRIMARY KEY (guild_id, target_user_id, follower_user_id)
                )`);

                // إنشاء الفهارس
                await runQuery(`CREATE INDEX IF NOT EXISTS idx_streak_users_guild ON streak_users(guild_id)`);
                await runQuery(`CREATE INDEX IF NOT EXISTS idx_streak_history_guild_user ON streak_history(guild_id, user_id)`);
                await runQuery(`CREATE INDEX IF NOT EXISTS idx_streak_restore_status ON streak_restore_requests(status)`);
                await runQuery(`CREATE INDEX IF NOT EXISTS idx_streak_followers_target ON streak_followers(guild_id, target_user_id, is_active)`);

                console.log('تم تهيئة قاعدة بيانات Streak بنجاح');
                resolve();
            } catch (error) {
                console.error('خطأ في تهيئة جداول Streak:', error);
                reject(error);
            }
        });
    });
}

function runQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject(new Error('Streak database not initialized'));
        }
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function getQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject(new Error('Streak database not initialized'));
        }
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function allQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject(new Error('Streak database not initialized'));
        }
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function readJsonFile(filePath, defaultData = {}) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (error) {
        console.error(`خطأ في قراءة ${filePath}:`, error);
    }
    return defaultData;
}

function normalizeDividerUrl(url) {
    if (!url) return null;
    const cleaned = url.trim().replace(/^<|>$/g, '');
    try {
        return new URL(cleaned).toString();
    } catch (error) {
        console.log(`⚠️ رابط خط فاصل غير صالح: ${url}`);
        return null;
    }
}

function getDividerCachePath(guildId, imageUrl) {
    const baseDir = path.join(__dirname, '..', 'data', 'streak_dividers');
    const extension = (() => {
        try {
            const parsedUrl = new URL(imageUrl);
            return path.extname(parsedUrl.pathname) || '.png';
        } catch (error) {
            return '.png';
        }
    })();
    return path.join(baseDir, `${guildId}${extension}`);
}

async function cacheDividerImage(guildId, imageUrl) {
    try {
        const baseDir = path.join(__dirname, '..', 'data', 'streak_dividers');
        if (!fs.existsSync(baseDir)) {
            fs.mkdirSync(baseDir, { recursive: true });
        }

        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 10000,
            maxRedirects: 5,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; StreakBot/1.0)',
                'Accept': 'image/*,*/*'
            }
        });

        const filePath = getDividerCachePath(guildId, imageUrl);
        fs.writeFileSync(filePath, Buffer.from(response.data, 'binary'));
        return filePath;
    } catch (error) {
        console.log(`⚠️ تعذر حفظ صورة الخط الفاصل محلياً: ${error.message}`);
        return null;
    }
}

function resolveDividerSource(settings, guildId) {
    const rawValue = settings?.dividerImageUrl;
    if (!rawValue) return null;

    if (rawValue.startsWith('local:')) {
        const localPath = rawValue.replace(/^local:/, '');
        if (fs.existsSync(localPath)) {
            return { type: 'local', path: localPath };
        }
        console.log(`⚠️ ملف الخط الفاصل المحلي غير موجود: ${localPath}`);
        return null;
    }

    const normalizedUrl = normalizeDividerUrl(rawValue);
    if (!normalizedUrl) return null;

    return { type: 'url', url: normalizedUrl };
}

function getDividerFilename(url) {
    try {
        const parsedUrl = new URL(url);
        const extension = path.extname(parsedUrl.pathname);
        if (extension) {
            return `divider${extension}`;
        }
    } catch (error) {
        console.log(`⚠️ تعذر استخراج امتداد من رابط الخط الفاصل: ${url}`);
    }
    return 'divider.png';
}

function extractGuildIdFromCustomId(customId) {
    const parts = customId.split('_');
    const isGuildId = (value) => /^\d{17,20}$/.test(value);

    if (parts.length >= 4 && parts[0] === 'streak' && parts[1] === 'request' && parts[2] === 'restore' && isGuildId(parts[3])) {
        return parts[3];
    }

    if (parts.length >= 5 && parts[0] === 'streak' && (parts[1] === 'approve' || parts[1] === 'reject') && parts[2] === 'restore' && isGuildId(parts[3])) {
        return parts[3];
    }

    return null;
}

async function getSettings(guildId) {
    try {
        const row = await getQuery('SELECT * FROM streak_settings WHERE guild_id = ?', [guildId]);
        if (!row) return null;
        
        return {
            approverType: row.approver_type,
            approverTargets: row.approver_targets ? JSON.parse(row.approver_targets) : [],
            lockedChannelId: row.locked_channel_id,
            dividerImageUrl: row.divider_image_url,
            reactionEmojis: row.reaction_emojis ? JSON.parse(row.reaction_emojis) : []
        };
    } catch (error) {
        console.error('Error in getSettings:', error);
        return null;
    }
}

async function saveSettings(guildId, settings) {
    const exists = await getQuery('SELECT guild_id FROM streak_settings WHERE guild_id = ?', [guildId]);
    
    if (exists) {
        await runQuery(`UPDATE streak_settings SET 
            approver_type = ?,
            approver_targets = ?,
            locked_channel_id = ?,
            divider_image_url = ?,
            reaction_emojis = ?
            WHERE guild_id = ?`, [
            settings.approverType || null,
            settings.approverTargets ? JSON.stringify(settings.approverTargets) : null,
            settings.lockedChannelId || null,
            settings.dividerImageUrl || null,
            settings.reactionEmojis ? JSON.stringify(settings.reactionEmojis) : null,
            guildId
        ]);
    } else {
        await runQuery(`INSERT INTO streak_settings (guild_id, approver_type, approver_targets, locked_channel_id, divider_image_url, reaction_emojis)
            VALUES (?, ?, ?, ?, ?, ?)`, [
            guildId,
            settings.approverType || null,
            settings.approverTargets ? JSON.stringify(settings.approverTargets) : null,
            settings.lockedChannelId || null,
            settings.dividerImageUrl || null,
            settings.reactionEmojis ? JSON.stringify(settings.reactionEmojis) : null
        ]);
    }
}

async function hasPermission(userId, guildId, guild, botOwners) {
    const settings = await getSettings(guildId);
    if (!settings || !settings.approverType) return false;

    if (settings.approverType === 'owners') {
        return botOwners.includes(userId);
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return false;

    if (settings.approverType === 'role') {
        const userRoles = member.roles.cache.map(role => role.id);
        return settings.approverTargets.some(roleId => userRoles.includes(roleId));
    }

    if (settings.approverType === 'responsibility') {
        const responsibilities = readJsonFile(responsibilitiesPath, {});
        for (const respName of settings.approverTargets) {
            const respData = responsibilities[respName];
            if (respData && respData.responsibles && respData.responsibles.includes(userId)) {
                return true;
            }
        }
    }

    return false;
}

async function hasPermissionFromMember(userId, guildId, member, botOwners) {
    const settings = await getSettings(guildId);
    if (!settings || !settings.approverType) return false;

    if (settings.approverType === 'owners') {
        return botOwners.includes(userId);
    }

    if (!member) return false;

    if (settings.approverType === 'role') {
        const userRoles = member.roles?.cache?.map(role => role.id) || [];
        return settings.approverTargets.some(roleId => userRoles.includes(roleId));
    }

    if (settings.approverType === 'responsibility') {
        const responsibilities = readJsonFile(responsibilitiesPath, {});
        for (const respName of settings.approverTargets) {
            const respData = responsibilities[respName];
            if (respData && respData.responsibles && respData.responsibles.includes(userId)) {
                return true;
            }
        }
    }

    return false;
}

function getTimeUntilMidnight() {
    const now = moment().tz('Asia/Riyadh');
    const midnight = moment().tz('Asia/Riyadh').endOf('day');
    const duration = moment.duration(midnight.diff(now));
    
    const hours = Math.floor(duration.asHours());
    const minutes = duration.minutes();
    const seconds = duration.seconds();
    
    return `**${hours}h , ${minutes}m , ${seconds}s**`;
}

function withEmbedAvatar(embed, user, label = 'Streak System') {
    if (!embed || !user) return embed;

    const avatarUrl = typeof user.displayAvatarURL === 'function'
        ? user.displayAvatarURL({ extension: 'png', size: 128 })
        : null;
    const userName = user.globalName || user.username || 'Unknown User';

    if (avatarUrl) {
        embed.setAuthor({ name: `${label} • ${userName}`, iconURL: avatarUrl });
        embed.setThumbnail(avatarUrl);
        return embed;
    }

    embed.setAuthor({ name: `${label} • ${userName}` });
    return embed;
}

function createStatusEmbed(settings = {}, actorUser = null) {
    let approverDisplay = 'غير محدد';
    if (settings.approverType === 'owners') {
        approverDisplay = 'Owners Only';
    } else if (settings.approverType === 'role' && settings.approverTargets && settings.approverTargets.length > 0) {
        approverDisplay = settings.approverTargets.map(id => `<@&${id}>`).join(', ');
    } else if (settings.approverType === 'responsibility' && settings.approverTargets && settings.approverTargets.length > 0) {
        approverDisplay = `أعضاء المسؤولية : ${settings.approverTargets.join(', ')}`;
    }

    let lockedChannelDisplay = settings.lockedChannelId ? `<#${settings.lockedChannelId}>` : 'غير محدد';
    let dividerDisplay = settings.dividerImageUrl ? 'تم التحديد' : 'غير محدد';
    let emojisDisplay = settings.reactionEmojis && settings.reactionEmojis.length > 0 
        ? settings.reactionEmojis.join(' ') 
        : 'غير محدد';

    const embed = colorManager.createEmbed()
        .setTitle('**Streak Sys**')
        .setDescription('نظام الستريكات لمسؤولين اللوكيت')
        .addFields(
            { name: '**المسؤولين**', value: approverDisplay, inline: false },
            { name: '**روم اللوكيت**', value: lockedChannelDisplay, inline: false },
            { name: '**صورة الخط **', value: dividerDisplay, inline: false },
            { name: '**الإيموجيات للرياكت**', value: emojisDisplay, inline: false }
        )
        .setFooter({ text: 'Streak System' });

    return withEmbedAvatar(embed, actorUser, 'Moderator');
}

function createMainButtons() {
    return new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('streak_set_approvers')
                .setLabel('تحديد المسؤولين')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('streak_set_channel')
                .setLabel('تحديد روم اللوكيت')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('streak_set_divider')
                .setLabel('تحديد الخط')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('streak_set_emojis')
                .setLabel('تحديد الإيموجيات')
                .setStyle(ButtonStyle.Secondary)
        );
}

function createBackButton() {
    return new ButtonBuilder()
        .setCustomId('streak_back_to_main')
        .setLabel('Back')
        .setStyle(ButtonStyle.Primary);
}

async function getUserStreak(guildId, userId) {
    return await getQuery('SELECT * FROM streak_users WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
}

async function updateUserStreak(guildId, userId, currentStreak, totalPosts) {
    const existing = await getUserStreak(guildId, userId);
    const today = moment().tz('Asia/Riyadh').format('YYYY-MM-DD');
    
    if (existing) {
        const longestStreak = Math.max(existing.longest_streak, currentStreak);
        await runQuery(`UPDATE streak_users SET 
            current_streak = ?,
            longest_streak = ?,
            last_post_date = ?,
            total_posts = ?
            WHERE guild_id = ? AND user_id = ?`, 
            [currentStreak, longestStreak, today, totalPosts, guildId, userId]);
    } else {
        await runQuery(`INSERT INTO streak_users 
            (guild_id, user_id, current_streak, longest_streak, last_post_date, total_posts)
            VALUES (?, ?, ?, ?, ?, ?)`, 
            [guildId, userId, currentStreak, currentStreak, today, totalPosts]);
    }
}

async function recordStreakHistory(guildId, userId, messageId, streakCount, imageLocalPath = null) {
    const today = moment().tz('Asia/Riyadh').format('YYYY-MM-DD');
    await runQuery(`INSERT INTO streak_history (guild_id, user_id, message_id, post_date, streak_count, image_local_path)
        VALUES (?, ?, ?, ?, ?, ?)`, [guildId, userId, messageId, today, streakCount, imageLocalPath]);
}

function getAttachmentExtension(attachment) {
    const name = (attachment?.name || '').toLowerCase();
    const fromName = path.extname(name);
    if (fromName) return fromName;

    const contentType = (attachment?.contentType || '').toLowerCase();
    if (contentType.includes('png')) return '.png';
    if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg';
    if (contentType.includes('webp')) return '.webp';
    if (contentType.includes('gif')) return '.gif';
    if (contentType.includes('bmp')) return '.bmp';
    if (contentType.includes('mp4')) return '.mp4';
    if (contentType.includes('webm')) return '.webm';
    if (contentType.includes('mov') || contentType.includes('quicktime')) return '.mov';
    if (contentType.includes('mkv')) return '.mkv';
    if (contentType.includes('avi')) return '.avi';
    if (contentType.includes('wmv')) return '.wmv';
    if (contentType.includes('flv')) return '.flv';
    if (contentType.includes('mp3')) return '.mp3';
    if (contentType.includes('wav')) return '.wav';
    if (contentType.includes('ogg')) return '.ogg';
    if (contentType.includes('m4a')) return '.m4a';
    if (contentType.includes('aac')) return '.aac';

    try {
        const parsed = new URL(attachment?.url || '');
        const fromUrl = path.extname(parsed.pathname);
        if (fromUrl) return fromUrl;
    } catch (error) {}

    return '.png';
}

function getExtensionFromUrlOrContentType(url, contentType = '') {
    const normalizedType = String(contentType || '').toLowerCase();
    if (normalizedType.includes('png')) return '.png';
    if (normalizedType.includes('jpeg') || normalizedType.includes('jpg')) return '.jpg';
    if (normalizedType.includes('webp')) return '.webp';
    if (normalizedType.includes('gif')) return '.gif';
    if (normalizedType.includes('bmp')) return '.bmp';
    if (normalizedType.includes('mp4')) return '.mp4';
    if (normalizedType.includes('webm')) return '.webm';
    if (normalizedType.includes('mov') || normalizedType.includes('quicktime')) return '.mov';
    if (normalizedType.includes('mkv')) return '.mkv';
    if (normalizedType.includes('avi')) return '.avi';
    if (normalizedType.includes('wmv')) return '.wmv';
    if (normalizedType.includes('flv')) return '.flv';
    if (normalizedType.includes('mp3')) return '.mp3';
    if (normalizedType.includes('wav')) return '.wav';
    if (normalizedType.includes('ogg')) return '.ogg';
    if (normalizedType.includes('m4a')) return '.m4a';
    if (normalizedType.includes('aac')) return '.aac';

    try {
        const parsed = new URL(url || '');
        const ext = path.extname(parsed.pathname);
        if (ext) return ext.toLowerCase();
    } catch (error) {}

    return '.dat';
}

function buildMediaCandidateUrls(attachment) {
    if (!attachment) return [];
    const urls = [attachment.url, attachment.proxyURL].filter(Boolean);

    // بديل إضافي شائع لروابط Discord CDN
    for (const url of [...urls]) {
        try {
            const parsed = new URL(url);
            if (parsed.hostname === 'cdn.discordapp.com') {
                parsed.hostname = 'media.discordapp.net';
                urls.push(parsed.toString());
            }
        } catch (error) {}
    }

    return [...new Set(urls)];
}

async function robustDownloadMediaBuffer(urls) {
    const candidates = Array.isArray(urls) ? urls.filter(Boolean) : [];
    if (!candidates.length) throw new Error('NO_MEDIA_URL');

    let lastError = null;

    for (const mediaUrl of candidates) {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
                const response = await axios.get(mediaUrl, {
                    responseType: 'arraybuffer',
                    timeout: 20000,
                    maxRedirects: 5,
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StreakBot/1.0)' }
                });

                const contentType = response.headers?.['content-type'] || '';
                const ext = getExtensionFromUrlOrContentType(mediaUrl, contentType);
                return { buffer: Buffer.from(response.data), ext, sourceUrl: mediaUrl, contentType };
            } catch (error) {
                lastError = error;
            }
        }
    }

    throw lastError || new Error('MEDIA_DOWNLOAD_FAILED');
}

function pickBestMediaAttachment(message) {
    if (!message?.attachments?.size) return null;

    const isAllowedMedia = (att) => {
        const contentType = (att?.contentType || '').toLowerCase();
        const fileName = (att?.name || '').toLowerCase();
        const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
        const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.flv'];
        const audioExtensions = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'];

        if (contentType.startsWith('image/')) return true;
        if (contentType.startsWith('video/')) return true;
        if (contentType.startsWith('audio/')) return true;
        if (imageExtensions.some(ext => fileName.endsWith(ext))) return true;
        if (videoExtensions.some(ext => fileName.endsWith(ext))) return true;
        if (audioExtensions.some(ext => fileName.endsWith(ext))) return true;
        return false;
    };

    const attachments = [...message.attachments.values()].filter(isAllowedMedia);
    if (!attachments.length) return null;

    return attachments.find(att => (att?.contentType || '').toLowerCase().startsWith('video/'))
        || attachments.find(att => (att?.contentType || '').toLowerCase().startsWith('image/'))
        || attachments[0];
}

async function cacheLockitMedia(message) {
    const mediaAttachment = pickBestMediaAttachment(message);
    if (!mediaAttachment?.url) return null;

    try {
        const folder = path.join(__dirname, '..', 'data', 'streak_posts', message.guild.id, message.author.id);
        if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

        const downloaded = await robustDownloadMediaBuffer(buildMediaCandidateUrls(mediaAttachment));
        const ext = downloaded.ext || getAttachmentExtension(mediaAttachment);
        const safeExt = ext.startsWith('.') ? ext : '.dat';
        const fileName = `${message.id}${safeExt}`;
        const localPath = path.join(folder, fileName);

        await fs.promises.writeFile(localPath, downloaded.buffer);
        return localPath;
    } catch (error) {
        console.log(`⚠️ تعذر حفظ ميديا اللوكيت محلياً: ${error.message}`);
        return null;
    }
}

async function createRestoreRequest(guildId, userId, previousStreak) {
    await runQuery(`INSERT INTO streak_restore_requests (guild_id, user_id, previous_streak)
        VALUES (?, ?, ?)`, [guildId, userId, previousStreak]);
}

async function sendStreakWarnings(client) {
    try {
        const allUsers = await allQuery('SELECT * FROM streak_users WHERE is_active = 1 AND current_streak > 0');
        const now = moment().tz('Asia/Riyadh');
        const today = now.format('YYYY-MM-DD');

        console.log(`⚠️ فحص ${allUsers.length} مستخدم لإرسال تحذيرات - التاريخ: ${today} - الوقت: ${now.format('HH:mm:ss')}`);

        for (const userStreak of allUsers) {
            if (!userStreak.last_post_date) continue;

            const isActiveToday = userStreak.last_post_date === today;
            
            if (!isActiveToday) {
                const user = await client.users.fetch(userStreak.user_id).catch(() => null);
                if (user) {
                    const settings = await getSettings(userStreak.guild_id);
                    const channelMention = settings && settings.lockedChannelId ? `<#${settings.lockedChannelId}>` : 'روم اللوكيت';
                    
                    try {
                        const warningEmbed = withEmbedAvatar(colorManager.createEmbed()
                                .setTitle('Streak Warn')
                                .setDescription(`سوف تخسر سلسلة الـ Streak الخاصة بك **${userStreak.current_streak}** <:emoji_64:1442587807150243932> يوم عند منتصف الليل!\n\n**أرسل صورة في ${channelMention} خلال الساعة القادمة للحفاظ على الـ Streak!**`)
                                .addFields([
                                    { name: ' الوقت المتبقي', value: getTimeUntilMidnight(), inline: true },
                                    { name: 'Your Streak', value: `${userStreak.current_streak} <:emoji_61:1442587727387427009>`, inline: true }
                                ])
                                .setColor('#FFFFFF')
                                .setFooter({ text: 'Streak System ' }), user, 'Member');

                        await user.send({ embeds: [warningEmbed] });
                        console.log(`⚠️ تم إرسال تحذير للمستخدم ${userStreak.user_id}`);
                    } catch (dmErr) {
                        console.log(`❌ لا يمكن إرسال DM للمستخدم ${userStreak.user_id}`);
                    }
                }
            }
        }
        
        console.log(`✅ اكتمل إرسال التحذيرات عند ${now.format('HH:mm:ss')}`);
    } catch (error) {
        console.error('❌ خطأ في إرسال تحذيرات الـ Streaks:', error);
    }
}

async function checkStreakExpiration(client) {
    try {
        const allUsers = await allQuery('SELECT * FROM streak_users WHERE is_active = 1 AND current_streak > 0');
        const now = moment().tz('Asia/Riyadh');
        const today = now.format('YYYY-MM-DD');
        const yesterday = now.clone().subtract(1, 'days').format('YYYY-MM-DD');

        console.log(`🔍 فحص ${allUsers.length} مستخدم نشط - التاريخ: ${today} - الوقت: ${now.format('HH:mm:ss')}`);

        for (const userStreak of allUsers) {
            if (!userStreak.last_post_date) {
                console.log(`⚠️ المستخدم ${userStreak.user_id} ليس لديه تاريخ آخر منشور - تخطي`);
                continue;
            }

            const daysSincePost = moment(today).diff(moment(userStreak.last_post_date), 'days');
            
            console.log(`📊 المستخدم ${userStreak.user_id}: آخر منشور=${userStreak.last_post_date}, أيام مضت=${daysSincePost}, streak=${userStreak.current_streak}`);

            // إذا مر يوم أو أكثر بدون نشر - إنهاء الـ Streak
            // المستخدم يجب أن ينشر يومياً قبل منتصف الليل
            if (daysSincePost >= 1) {
                console.log(`💔 إنهاء Streak للمستخدم ${userStreak.user_id} - ${userStreak.current_streak} يوم - عدد الأيام المنقضية: ${daysSincePost}`);
                
                await runQuery('UPDATE streak_users SET current_streak = 0 WHERE guild_id = ? AND user_id = ?', 
                    [userStreak.guild_id, userStreak.user_id]);

                const user = await client.users.fetch(userStreak.user_id).catch(() => null);
                if (user) {
                    const restoreButton = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId(`streak_request_restore_${userStreak.guild_id}`)
                                .setLabel('طلب استعادة الـ Streak')
                                .setStyle(ButtonStyle.Primary)
                        );

                    try {
                        const endedEmbed = withEmbedAvatar(colorManager.createEmbed()
                                .setTitle('Streak Ended')
                                .setDescription(`لقد خسرت سلسلة الـ Streak التي دامت **${userStreak.current_streak}** <:emoji_61:1442587727387427009>.\n\n**السبب :** لم تقم بإرسال صورة خلال يوم\n\n**يمكنك طلب استعادة الـ Streak من المسؤولين**`)
                                .addFields([
                                    { name: 'Last Pic', value: userStreak.last_post_date, inline: true },
                                    { name: 'Time to end', value: now.format('YYYY-MM-DD HH:mm:ss'), inline: true }
                                ])
                                
                                .setFooter({ text: 'Streak System ' }), user, 'Member');

                        await user.send({
                            embeds: [endedEmbed],
                            components: [restoreButton]
                        });
                        console.log(`✅ تم إرسال إشعار خسارة Streak للمستخدم ${userStreak.user_id}`);
                    } catch (dmErr) {
                        console.log(`❌ لا يمكن إرسال DM للمستخدم ${userStreak.user_id}`);
                    }
                }
            }
        }
        
        console.log(`✅ اكتمل فحص انتهاء الـ Streaks عند ${now.format('HH:mm:ss')}`);
    } catch (error) {
        console.error('❌ خطأ في فحص انتهاء الـ Streaks:', error);
    }
}

const messageCollectors = new Map();
const lastPosterByChannel = new Map();

async function handleLockedRoomMessage(message, client, botOwners) {
    if (message.author.bot) return;

    // التأكد من تهيئة قاعدة البيانات
    if (!db) {
        console.log('⚠️ قاعدة البيانات غير مهيأة، محاولة التهيئة...');
        try {
            await initializeDatabase();
        } catch (error) {
            console.error('❌ فشل في تهيئة قاعدة البيانات:', error);
            return;
        }
    }

    const guildId = message.guild.id;
    const settings = await getSettings(guildId);
    
    
    
    if (!settings) {
        if (!warnedGuilds.has(guildId)) {
            warnedGuilds.add(guildId);
            console.log(`⚠️ لا توجد إعدادات Streak للسيرفر ${guildId} (هذا التحذير يظهر مرة واحدة فقط)`);
        }
        return;
    }
    
    if (!settings.lockedChannelId) {
        console.log(`⚠️ لم يتم تحديد روم اللوكيت بعد`);
        return;
    }
    
    if (message.channel.id !== settings.lockedChannelId) {
        
        return;
    }
    
    console.log(`✅ الرسالة في روم اللوكيت - فحص المحتوى...`);

    const hasAllowedMedia = message.attachments.some(att => {
        const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
        const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.flv'];
        const audioExtensions = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'];
        
        if (att.contentType) {
            if (att.contentType.startsWith('image/')) return true;
            if (att.contentType.startsWith('video/')) return true;
            if (att.contentType.startsWith('audio/')) return true;
        }
        
        const fileName = att.name.toLowerCase();
        if (imageExtensions.some(ext => fileName.endsWith(ext))) return true;
        if (videoExtensions.some(ext => fileName.endsWith(ext))) return true;
        if (audioExtensions.some(ext => fileName.endsWith(ext))) return true;
        
        return false;
    });

    const isAdmin = await hasPermission(message.author.id, guildId, message.guild, botOwners);
    
    // إذا كانت الرسالة تحتوي على صورة أو فيديو أو صوت - مسموح من الجميع
    if (hasAllowedMedia) {
        console.log(`✅ الرسالة تحتوي على ميديا من ${message.author.username} - مسموح`);
    }
    // إذا كانت نص فقط (بدون ميديا)
    else {
        // إذا لم يكن من المسؤولين - حذف الرسالة
        if (!isAdmin) {
            try {
                const wasDeleted = await safeDeleteMessage(message, `رسالة ${message.author.username}`);
                if (wasDeleted) {
                    console.log(`🗑️ تم حذف رسالة نصية من ${message.author.username} - ليس من المسؤولين`);
                }
            } catch (error) {
                console.error(`❌ فشل في حذف رسالة ${message.author.username}:`, error);
            }
            return;
        }
        // المسؤول يكتب نص فقط - مسموح
        else {
            console.log(`✅ المسؤول ${message.author.username} كتب رسالة نصية - مسموح`);
            return;
        }
    }

    if (hasAllowedMedia) {
        console.log(`✅ تم اكتشاف ميديا في رسالة ${message.author.username}`);
        
        const today = moment().tz('Asia/Riyadh').format('YYYY-MM-DD');
        const userStreak = await getUserStreak(guildId, message.author.id);

        // إضافة التفاعلات أولاً (حتى لو نشر اليوم)
        console.log(`🔍 فحص التفاعلات - عدد الإيموجيات: ${settings.reactionEmojis?.length || 0}`);
        
        if (settings.reactionEmojis && settings.reactionEmojis.length > 0) {
            console.log(`📋 الإيموجيات المحددة: ${JSON.stringify(settings.reactionEmojis)}`);
            for (const emoji of settings.reactionEmojis) {
                try {
                    await message.react(emoji);
                    console.log(`✅ تم التفاعل بـ ${emoji} على رسالة ${message.author.username}`);
                } catch (err) {
                    console.error(`❌ فشل التفاعل بـ ${emoji}:`, err.message);
                }
            }
        } else {
            console.log('⚠️ لا توجد إيموجيات محددة للتفاعل');
        }

        // إنشاء خط فاصل جديد لكل صورة (حتى من نفس الشخص)
        lastPosterByChannel.set(message.channel.id, message.author.id);
        console.log(`➕ إنشاء خط فاصل جديد للصورة من ${message.author.username}`);
        await createDivider(message.channel, message.author, settings, guildId, [message.id]);

        const localImagePath = await cacheLockitMedia(message);

        // فحص هل تم النشر اليوم
        if (userStreak && userStreak.last_post_date === today) {
            console.log(`ℹ️ المستخدم ${message.author.username} نشر بالفعل اليوم - تحديث إحصائيات فقط`);
            await updateUserStreak(guildId, message.author.id, userStreak.current_streak, (userStreak.total_posts || 0) + 1);
            await recordStreakHistory(guildId, message.author.id, message.id, userStreak.current_streak, localImagePath);
            await notifyFollowersForNewPost(message.client, guildId, message.author.id, message.url);
            return;
        }

        let newStreakCount = 1;
        let shouldResetStreak = false;

        if (userStreak) {
            const lastPostDate = userStreak.last_post_date;
            const daysSinceLastPost = moment(today).diff(moment(lastPostDate), 'days');
            
            if (daysSinceLastPost === 1) {
                newStreakCount = userStreak.current_streak + 1;
            } else if (daysSinceLastPost > 1) {
                newStreakCount = 1;
                shouldResetStreak = true;
            } else {
                newStreakCount = userStreak.current_streak;
            }
        }

        await updateUserStreak(guildId, message.author.id, newStreakCount, (userStreak?.total_posts || 0) + 1);
        await recordStreakHistory(guildId, message.author.id, message.id, newStreakCount, localImagePath);

        // إلغاء طلبات الاستعادة المعلقة إذا بدأ المستخدم ستريك جديداً
        if (newStreakCount > 0) {
            await runQuery(
                'UPDATE streak_restore_requests SET status = "cancelled", resolved_at = strftime("%s", "now") WHERE guild_id = ? AND user_id = ? AND status = "pending"',
                [guildId, message.author.id]
            );
        }

        console.log(`🔥 تحديث الستريك لـ ${message.author.username}: ${newStreakCount}`);

        await notifyFollowersForNewPost(message.client, guildId, message.author.id, message.url);

        try {
            let dmEmbed = withEmbedAvatar(colorManager.createEmbed()
                .setTitle('** Streak Update**')
                .setDescription(`الـ Streak الخاص بك : **${newStreakCount}** <:emoji_64:1442587807150243932>\n\n**حافظ على السلسلة بإرسال صورة يومياً قبل منتصف الليل**`)
                .addFields([
                    { name: 'Your Streak ', value: `**${newStreakCount}**<:emoji_61:1442587727387427009>`, inline: true },
                    { name: 'Until New day', value: getTimeUntilMidnight(), inline: true },
                     { name: 'ستريكي', value: `** أمر رؤية احصائياتك والفولورز ** `, inline: true }
                ])
                .setFooter({ text: 'Streak System' }), message.author, 'Member');

            if (shouldResetStreak && userStreak) {
                dmEmbed.setColor('#FFFFFF')
                    .setDescription(`تم إعادة تعيين الـ Streak\n\n**السبب :** لم تنشر في اليوم السابق\n**الستريك السابق :** ${userStreak.current_streak} <:emoji_63:1442587778964525077>`);
            }

            await message.author.send({ embeds: [dmEmbed] }).catch(() => {});
        } catch (dmErr) {
            console.log(`لا يمكن إرسال DM للمستخدم ${message.author.id}`);
        }
    }
}

async function createDivider(channel, user, settings, guildId, userMessageIds = []) {
    const dividerSource = resolveDividerSource(settings, guildId);
    if (!dividerSource) {
        console.log('⚠️ لا يوجد رابط صورة للخط الفاصل في الإعدادات');
        return;
    }

    console.log(`🖼️ إنشاء خط فاصل للمستخدم ${user.username} - المصدر: ${dividerSource.type}`);

    const deleteButton = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`streak_delete_${user.id}`)
                .setLabel('Delete Pic')
.setEmoji('<:emoji_21:1465336647477493894>')                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`streak_follow_${user.id}`)
                 .setLabel('Follow')
                .setEmoji('<:emoji_40:1476120711046107136>')
                .setStyle(ButtonStyle.Secondary)
        );

    try {
        let dividerMsg;

        if (dividerSource.type === 'local') {
            const attachment = new AttachmentBuilder(dividerSource.path);
            dividerMsg = await channel.send({
                files: [attachment],
                components: [deleteButton]
            });
            console.log(`✅ تم إرسال الخط الفاصل من الملف المحلي - معرف الرسالة: ${dividerMsg.id}`);
        } else {
            const cachedPath = await cacheDividerImage(guildId, dividerSource.url);
            if (cachedPath) {
                const attachment = new AttachmentBuilder(cachedPath);
                dividerMsg = await channel.send({
                    files: [attachment],
                    components: [deleteButton]
                });
                console.log(`✅ تم إرسال الخط الفاصل من التخزين المحلي - معرف الرسالة: ${dividerMsg.id}`);
                const updatedSettings = { ...settings, dividerImageUrl: `local:${cachedPath}` };
                await saveSettings(guildId, updatedSettings);
            }
        }

        if (!dividerMsg && dividerSource.type === 'url') {
            try {
                const response = await axios.get(dividerSource.url, { 
                    responseType: 'arraybuffer',
                    timeout: 10000,
                    maxRedirects: 5,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; StreakBot/1.0)',
                        'Accept': 'image/*,*/*'
                    }
                });
                
                const buffer = Buffer.from(response.data, 'binary');
                const filename = getDividerFilename(dividerSource.url);
                
                const attachment = new AttachmentBuilder(buffer, { name: filename });
                
                dividerMsg = await channel.send({ 
                    files: [attachment],
                    components: [deleteButton]
                });
                
                console.log(`✅ تم إرسال الخط الفاصل كـ attachment - معرف الرسالة: ${dividerMsg.id}`);
            } catch (downloadError) {
                console.log(`❌ فشل تحميل صورة الخط الفاصل:`, downloadError.message);
                try {
                    const filename = getDividerFilename(dividerSource.url);
                    dividerMsg = await channel.send({
                        files: [{ attachment: dividerSource.url, name: filename }],
                        components: [deleteButton]
                    });
                    console.log(`✅ تم إرسال الخط الفاصل من الرابط مباشرة - معرف الرسالة: ${dividerMsg.id}`);
                } catch (sendError) {
                    console.log(`❌ فشل إرسال الخط الفاصل من الرابط:`, sendError.message);
                }
            }
        }
        
        if (!dividerMsg) {
            console.log(`⚠️ لم يتم إنشاء رسالة خط فاصل بسبب فشل التحميل`);
            return;
        }

        await runQuery(`INSERT INTO streak_dividers (guild_id, channel_id, message_id, user_id, user_message_ids)
            VALUES (?, ?, ?, ?, ?)`, 
            [guildId, channel.id, dividerMsg.id, user.id, JSON.stringify(userMessageIds)]);
        
        console.log(`✅ تم حفظ الخط الفاصل في قاعدة البيانات`);
    } catch (error) {
        console.error('❌ خطأ في إنشاء الخط الفاصل:', error);
        console.error('تفاصيل الخطأ:', error.message);
        console.error('الإعدادات:', JSON.stringify(settings));
    }
}

async function getFollowerEntry(guildId, targetUserId, followerUserId) {
    return getQuery(
        'SELECT * FROM streak_followers WHERE guild_id = ? AND target_user_id = ? AND follower_user_id = ?',
        [guildId, targetUserId, followerUserId]
    );
}

async function setFollowerState(guildId, targetUserId, followerUserId, isAnonymous, isActive) {
    await runQuery(`
        INSERT INTO streak_followers (guild_id, target_user_id, follower_user_id, is_anonymous, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'), strftime('%s', 'now'))
        ON CONFLICT(guild_id, target_user_id, follower_user_id)
        DO UPDATE SET
            is_anonymous = excluded.is_anonymous,
            is_active = excluded.is_active,
            updated_at = strftime('%s', 'now')
    `, [guildId, targetUserId, followerUserId, isAnonymous ? 1 : 0, isActive ? 1 : 0]);
}

async function notifyFollowStateChange(client, guild, targetUserId, followerUserId, isAnonymous, isFollowing) {
    const targetUser = await client.users.fetch(targetUserId).catch(() => null);
    if (!targetUser) return;

    const followerText = isAnonymous ? 'شخص مجهول' : `العضو <@${followerUserId}>`;
    const actionText = isFollowing
        ? `**${followerText} قام بمتابعة لوكيتاتك الآن، وأي لوكيت جديد سيتم إرسال تنبيه له.**`
        : `**${followerText} أزال متابعة لوكيتاتك.**`;

    const followerUser = !isAnonymous
        ? await client.users.fetch(followerUserId).catch(() => null)
        : null;

    const followEmbed = withEmbedAvatar(colorManager.createEmbed()
        .setTitle(isFollowing ? '**Member Follow You**' : '**Member Unfollow You**')
        .setDescription(actionText)
        .setFooter({ text: guild?.name || 'Streak System' }), followerUser || targetUser, isAnonymous ? 'Follower' : 'Member');

    await targetUser.send({
        embeds: [followEmbed]
    }).catch(() => {});
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function notifyFollowersForNewPost(client, guildId, authorId, messageUrl = null) {
    const followers = await allQuery(
        'SELECT follower_user_id, is_anonymous FROM streak_followers WHERE guild_id = ? AND target_user_id = ? AND is_active = 1 LIMIT ?',
        [guildId, authorId, FOLLOWER_NOTIFY_MAX_PER_POST]
    );

    if (!followers.length) return;

    const truncated = followers.length >= FOLLOWER_NOTIFY_MAX_PER_POST;

    for (let i = 0; i < followers.length; i += FOLLOWER_NOTIFY_BATCH_SIZE) {
        const batch = followers.slice(i, i + FOLLOWER_NOTIFY_BATCH_SIZE);

        await Promise.all(batch.map(async (follower) => {
            const user = await client.users.fetch(follower.follower_user_id).catch(() => null);
            if (!user) return;

            const authorUser = await client.users.fetch(authorId).catch(() => null);
            const alertEmbed = withEmbedAvatar(colorManager.createEmbed()
                .setTitle('**Locket Alert**')
                .setDescription(`**العضو : <@${authorId}> نزل لوكيت جديد الآن.\nحالة متابعتك : ${follower.is_anonymous ? 'مجهول' : 'باسمك'}${messageUrl ? `\n[رابط رسالة اللوكيت](${messageUrl})` : ''}**`)
                .setFooter({ text: truncated ? `Streak System • تم تحديد الإرسال لأول ${FOLLOWER_NOTIFY_MAX_PER_POST}` : 'Streak System' }), authorUser, 'Member');

            await user.send({ embeds: [alertEmbed] }).catch(() => {});
        }));

        if (i + FOLLOWER_NOTIFY_BATCH_SIZE < followers.length) {
            await wait(FOLLOWER_NOTIFY_BATCH_DELAY_MS);
        }
    }
}


async function getTopReactionPostForUser(guild, channelId, userId) {
    if (!channelId) return null;

    const history = await allQuery(
        'SELECT message_id, image_local_path FROM streak_history WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?',
        [guild.id, userId, REACTION_SEARCH_HISTORY_LIMIT]
    );

    if (!history.length) return null;

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return null;

    let best = null;
    let bestCount = -1;

    let bestLocalPath = null;

    for (const row of history) {
        if (!row.message_id) continue;
        const msg = await channel.messages.fetch(row.message_id).catch(() => null);
        if (!msg) continue;

        const reactions = [...msg.reactions.cache.values()].reduce((sum, reaction) => sum + reaction.count, 0);
        if (reactions > bestCount) {
            bestCount = reactions;
            best = msg;
            bestLocalPath = row.image_local_path || null;
        }
    }

    if (!best) return null;

    const bestMediaAttachment = pickBestMediaAttachment(best);
    const mediaContentType = (bestMediaAttachment?.contentType || '').toLowerCase();
    const mediaKind = mediaContentType.startsWith('video/')
        ? 'video'
        : mediaContentType.startsWith('audio/')
            ? 'audio'
            : 'image';

    return {
        message: best,
        reactionsCount: Math.max(bestCount, 0),
        mediaUrl: bestMediaAttachment?.url || null,
        mediaCandidateUrls: buildMediaCandidateUrls(bestMediaAttachment),
        mediaKind,
        localPath: bestLocalPath
    };
}

async function handleShowTopReactionImage(interaction) {
    const parts = interaction.customId.split('_');
    const ownerUserId = parts[4];
    const requesterUserId = parts[5] || ownerUserId;

    if (interaction.user.id !== requesterUserId) {
        return interaction.reply({ content: '**هذا الزر للشخص اللي طلب  فقط**', flags: 64 });
    }

    const guildId = interaction.guild?.id;
    if (!guildId) {
        return interaction.reply({ content: '**تعذر تحديد السيرفر**', flags: 64 });
    }

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: 64 });
    }

    const settings = await getSettings(guildId);
    if (!settings?.lockedChannelId) {
        return interaction.editReply({ content: '**روم اللوكيت غير مضبوط حالياً**' });
    }

    const bestPost = await getTopReactionPostForUser(interaction.guild, settings.lockedChannelId, ownerUserId);
    if (!bestPost) {
        return interaction.editReply({ content: '**ما حصلت ميديا لوكيت مناسبة لعرض أعلى رياكشن**' });
    }

    const postOwner = await interaction.client.users.fetch(ownerUserId).catch(() => null);
    const embed = withEmbedAvatar(colorManager.createEmbed()
        .setTitle('**أعلى ميديا صاحبة اكثر رياكشنات لهذا الشخص**')
        .setDescription(`**عدد الرياكشنات :** ${bestPost.reactionsCount}
[رابط الرسالة الأصلية](${bestPost.message.url})`)
        .setFooter({ text: 'Streak System' }), postOwner, 'Member');

    if (bestPost.localPath && fs.existsSync(bestPost.localPath)) {
        const ext = path.extname(bestPost.localPath) || '.dat';
        const safeExt = ext.startsWith('.') ? ext : '.dat';
        const fileName = `top-reaction-${ownerUserId}${safeExt}`;
        const attachment = new AttachmentBuilder(bestPost.localPath, { name: fileName });

        if (bestPost.mediaKind === 'image') {
            embed.setImage(`attachment://${fileName}`);
            return interaction.editReply({ embeds: [embed], files: [attachment] });
        }

        if (bestPost.mediaKind === 'video') {
            embed.addFields({ name: 'النوع', value: 'Video', inline: true });
        } else if (bestPost.mediaKind === 'audio') {
            embed.addFields({ name: 'النوع', value: 'Audio', inline: true });
        }

        return interaction.editReply({ content: `**تم إرفاق الميديا الأصلية (${bestPost.mediaKind})**`, embeds: [embed], files: [attachment] });
    }

    if (bestPost.mediaUrl) {
        try {
            const mediaResponse = await robustDownloadMediaBuffer(bestPost.mediaCandidateUrls || [bestPost.mediaUrl]);
            const ext = mediaResponse.ext || getExtensionFromUrlOrContentType(bestPost.mediaUrl, mediaResponse.contentType);
            const safeExt = ext.startsWith('.') ? ext : '.dat';
            const fileName = `top-reaction-${ownerUserId}${safeExt}`;
            const attachment = new AttachmentBuilder(mediaResponse.buffer, { name: fileName });

            if (bestPost.mediaKind === 'image') {
                embed.setImage(`attachment://${fileName}`);
            } else {
                embed.addFields({ name: 'نوع الميديا', value: bestPost.mediaKind, inline: true });
            }

            return interaction.editReply({ content: `**تم إرفاق الميديا الأصلية (${bestPost.mediaKind})**`, embeds: [embed], files: [attachment] });
        } catch (downloadError) {
            console.error('Failed to download top reaction media directly:', downloadError.message);
            try {
                const fallbackName = `top-reaction-${ownerUserId}${getExtensionFromUrlOrContentType(bestPost.mediaUrl)}`;
                const remoteAttachment = { attachment: bestPost.mediaUrl, name: fallbackName };
                if (bestPost.mediaKind === 'image') {
                    embed.setImage(`attachment://${fallbackName}`);
                } else {
                    embed.addFields({ name: 'نوع الميديا', value: bestPost.mediaKind, inline: true });
                }
                return interaction.editReply({ content: `**تم إرفاق الميديا الأصلية (${bestPost.mediaKind})**`, embeds: [embed], files: [remoteAttachment] });
            } catch (fallbackError) {
                console.error('Fallback URL attachment failed:', fallbackError.message);
                embed.addFields({ name: 'نوع الميديا', value: bestPost.mediaKind, inline: true });
                return interaction.editReply({ content: '**تعذر تحميل الميديا كمرفق حالياً.**', embeds: [embed] });
            }
        }
    }

    return interaction.editReply({ embeds: [embed] });
}

async function handleFollowButton(interaction, client) {
    const targetUserId = interaction.customId.split('_')[2];
    const guildId = interaction.guild?.id;
    if (!guildId) return interaction.reply({ content: '**تعذر تحديد السيرفر**', flags: 64 });

    if (interaction.user.id === targetUserId) {
        return interaction.reply({ content: '**ما تقدر تتابع نفسك**', flags: 64 });
    }

    const followerEntry = await getFollowerEntry(guildId, targetUserId, interaction.user.id);

    if (followerEntry?.is_active) {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`streak_unfollow_yes_${targetUserId}`).setLabel('نعم').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`streak_follow_cancel_${targetUserId}`).setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
        );

        return interaction.reply({
            content: ' هل تريد إزالة الفولو و تنبيه اللوكيت؟',
            components: [row],
            flags: 64
        });
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`streak_follow_yes_${targetUserId}`).setLabel('نعم').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`streak_follow_anon_${targetUserId}`).setLabel('لا، متابعة كمجهول').setStyle(ButtonStyle.Secondary)
    );

    return interaction.reply({
        content: `✅️ ** Done You Follow This Member **\n * تبي اسمك يظهر ولا متابعه كشخص مجهول *`,
        components: [row],
        flags: 64
    });
}

async function handleFollowConfirmation(interaction, client, mode) {
    const targetUserId = interaction.customId.split('_')[3];
    const guildId = interaction.guild?.id;
    if (!guildId) return interaction.update({ content: '**تعذر تحديد السيرفر**', components: [] });

    const isAnonymous = mode === 'anon';
    await setFollowerState(guildId, targetUserId, interaction.user.id, isAnonymous, true);
    await notifyFollowStateChange(client, interaction.guild, targetUserId, interaction.user.id, isAnonymous, true);

    return interaction.update({
        content: isAnonymous ? '**Done !**' : '**Done ! ✅**',
        components: []
    });
}

async function handleUnfollowConfirmation(interaction, client) {
    const targetUserId = interaction.customId.split('_')[3];
    const guildId = interaction.guild?.id;
    if (!guildId) return interaction.update({ content: '**تعذر تحديد السيرفر**', components: [] });

    const followerEntry = await getFollowerEntry(guildId, targetUserId, interaction.user.id);
    const wasAnonymous = followerEntry ? !!followerEntry.is_anonymous : true;
    await setFollowerState(guildId, targetUserId, interaction.user.id, wasAnonymous, false);
    await notifyFollowStateChange(client, interaction.guild, targetUserId, interaction.user.id, wasAnonymous, false);

    return interaction.update({ content: '**تمت إزالة ال Follow بنجاح ✅**', components: [] });
}

async function handleDividerDelete(interaction, botOwners) {
    const userId = interaction.customId.split('_')[2];
    const member = interaction.member;
    const guildId = interaction.guild?.id;

    if (!guildId) {
        return interaction.reply({ content: '**تعذر تحديد السيرفر لهذا الطلب**', flags: 64 });
    }

    const isAdmin = await hasPermissionFromMember(interaction.user.id, guildId, member, botOwners);
    if (!isAdmin) {
        return interaction.reply({ content: '**تبي تحذف صور الناس؟ باند**', flags: 64 });
    }

    const modal = new ModalBuilder()
        .setCustomId(`streak_delete_reason_${userId}_${interaction.message.id}`)
        .setTitle('Reason');

    const reasonInput = new TextInputBuilder()
        .setCustomId('delete_reason')
        .setLabel('ما هو سبب حذف الصور؟')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(500);

    modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));

    await interaction.showModal(modal);
}

async function handleDeleteReasonModal(interaction, client, botOwners) {
    const [, , , userId, dividerMessageId] = interaction.customId.split('_');
    const reason = interaction.fields.getTextInputValue('delete_reason');

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
    }

    if (!db) {
        console.log('⚠️ قاعدة البيانات غير مهيأة أثناء حذف الخط الفاصل');
        return interaction.editReply({ content: '**تعذر تنفيذ الحذف حالياً**' });
    }

    const guildId = interaction.guild?.id;
    if (!guildId) {
        return interaction.editReply({ content: '**تعذر تحديد السيرفر لهذا الطلب**' });
    }

    const isAdmin = await hasPermission(interaction.user.id, guildId, interaction.guild, botOwners);
    if (!isAdmin) {
        return interaction.editReply({ content: '**تبي تحذف صور الناس؟ باند**' });
    }

    const divider = await getQuery('SELECT * FROM streak_dividers WHERE message_id = ?', [dividerMessageId]);
    
    if (!divider) {
        return interaction.editReply({ content: '**لم يتم العثور على معلومات الخط الفاصل**' });
    }

    let userMessageIds = [];
    try {
        userMessageIds = JSON.parse(divider.user_message_ids || '[]');
        if (!Array.isArray(userMessageIds)) {
            userMessageIds = [];
        }
    } catch (parseError) {
        console.log(`⚠️ تعذر قراءة user_message_ids للخط الفاصل ${dividerMessageId}: ${parseError.message}`);
    }

    const activeChannel = interaction.channel;
    if (!activeChannel || !activeChannel.isTextBased?.()) {
        await runQuery('DELETE FROM streak_dividers WHERE message_id = ?', [dividerMessageId]);
        return interaction.editReply({ content: '**تعذر الوصول للروم الآن، تم تنظيف السجل فقط**' });
    }

    // حذف الصورة المرتبطة بهذا الخط الفاصل فقط
    for (const msgId of userMessageIds) {
        try {
            const msg = await activeChannel.messages.fetch(msgId).catch(() => null);
            if (msg) {
                await safeDeleteMessage(msg, `رسالة المستخدم ${msgId}`);
            }
        } catch (err) {
            if (isIgnorableDiscordError(err)) {
                console.log(`ℹ️ تم تجاهل خطأ متوقع أثناء حذف الرسالة ${msgId}: ${err.message}`);
            } else {
                console.error(`فشل حذف الرسالة ${msgId}:`, err.message);
            }
        }
    }

    // حذف الخط الفاصل
    try {
        const dividerMessage = await activeChannel.messages.fetch(dividerMessageId).catch(() => null);
        if (dividerMessage) {
            await safeDeleteMessage(dividerMessage, `الخط الفاصل ${dividerMessageId}`);
        }
    } catch (err) {
        if (isIgnorableDiscordError(err)) {
            console.log(`ℹ️ تم تجاهل خطأ متوقع أثناء حذف الخط الفاصل ${dividerMessageId}: ${err.message}`);
        } else {
            console.error('فشل حذف الخط الفاصل:', err.message);
        }
    }

    await runQuery('DELETE FROM streak_dividers WHERE message_id = ?', [dividerMessageId]);

    const user = await client.users.fetch(userId).catch(() => null);
    if (user) {
        try {
            const deleteNoticeEmbed = withEmbedAvatar(colorManager.createEmbed()
                .setTitle('** من المسؤولين : تم حذف صورتك من روم اللوكيت**')
                .setDescription(`**السبب :** ${reason}`)
                .setFooter({ text: 'Streak System' }), interaction.user, 'Moderator');

            await user.send({ embeds: [deleteNoticeEmbed] });
        } catch (dmErr) {
            console.log(`لا يمكن إرسال DM للمستخدم ${userId}`);
        }
    }

    await interaction.editReply({ content: '**تم حذف الصورة وإرسال السبب للعضو**' });
}

async function handleRestoreRequest(interaction, client, botOwners) {
    const guildId = interaction.customId.split('_')[3] || extractGuildIdFromCustomId(interaction.customId);
    const userId = interaction.user.id;

    if (!guildId) {
        return interaction.reply({ content: '**تعذر تحديد السيرفر للطلب**', flags: 64 });
    }

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
    }

    const userStreak = await getUserStreak(guildId, userId);
    if (!userStreak || userStreak.current_streak > 0) {
        return interaction.editReply({ content: '**لا يمكن طلب استعادة الـ Streak حالياً**' });
    }

    const existingRequest = await getQuery(
        'SELECT * FROM streak_restore_requests WHERE guild_id = ? AND user_id = ? AND status = ?',
        [guildId, userId, 'pending']
    );

    if (existingRequest) {
        return interaction.editReply({ content: '**لديك طلب استعادة قيد الانتظار بالفعل**' });
    }

    await createRestoreRequest(guildId, userId, userStreak.longest_streak);

    const settings = await getSettings(guildId);
    const guild = await client.guilds.fetch(guildId);
    
    if (settings && settings.approverType) {
        const approvers = await getApprovers(settings, guild, botOwners);
        
        for (const approverId of approvers) {
            const approver = await client.users.fetch(approverId).catch(() => null);
            if (approver) {
                const approveButtons = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`streak_approve_restore_${guildId}_${userId}`)
                            .setLabel('موافقة')
                            .setStyle(ButtonStyle.Success),
                        new ButtonBuilder()
                            .setCustomId(`streak_reject_restore_${guildId}_${userId}`)
                            .setLabel('رفض')
                            .setStyle(ButtonStyle.Danger)
                    );

                try {
                    const restoreRequestEmbed = withEmbedAvatar(colorManager.createEmbed()
                        .setTitle('**طلب استعادة Streak**')
                        .setDescription(`العضو <@${userId}> يطلب استعادة سلسلة الـ Streak.\n\n**السلسلة السابقة :** ${userStreak.longest_streak} <:emoji_60:1442587701474754760>`)
                        .setFooter({ text: 'Streak System' }), interaction.user, 'Member');

                    await approver.send({
                        embeds: [restoreRequestEmbed],
                        components: [approveButtons]
                    });
                } catch (dmErr) {
                    console.log(`لا يمكن إرسال DM للمعتمد ${approverId}`);
                }
            }
        }
    }

    await interaction.editReply({ content: '**تم إرسال طلب استعادة الـ Streak للمسؤولين**' });
}

async function getApprovers(settings, guild, botOwners) {
    const approvers = [];

    if (settings.approverType === 'owners') {
        return botOwners;
    }

    if (settings.approverType === 'role') {
        for (const roleId of settings.approverTargets) {
            const role = guild.roles.cache.get(roleId);
            if (role) {
                const members = role.members.map(m => m.user.id);
                approvers.push(...members);
            }
        }
    }

    if (settings.approverType === 'responsibility') {
        const responsibilities = readJsonFile(responsibilitiesPath, {});
        for (const respName of settings.approverTargets) {
            const respData = responsibilities[respName];
            if (respData && respData.responsibles) {
                approvers.push(...respData.responsibles);
            }
        }
    }

    return [...new Set(approvers)];
}

async function handleApproveRestore(interaction, client, botOwners) {
    const [, , , guildId, userId] = interaction.customId.split('_');

    if (!guildId || !userId) {
        return interaction.reply({ content: '**تعذر تحديد بيانات الطلب**', flags: 64 });
    }

    const settings = await getSettings(guildId);
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!settings || !guild) {
        return interaction.reply({ content: '**تعذر تحميل إعدادات السيرفر**', flags: 64 });
    }

    const approvers = await getApprovers(settings, guild, botOwners || []);
    if (!approvers.includes(interaction.user.id)) {
        return interaction.reply({ content: '**ليس لديك صلاحية لقبول الطلب**', flags: 64 });
    }

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
    }

    const request = await getQuery(
        'SELECT * FROM streak_restore_requests WHERE guild_id = ? AND user_id = ? AND status = "pending" ORDER BY created_at DESC LIMIT 1',
        [guildId, userId]
    );

    if (!request) {
        // التحقق مما إذا كان الطلب قد تم إلغاؤه تلقائياً
        const cancelledRequest = await getQuery(
            'SELECT * FROM streak_restore_requests WHERE guild_id = ? AND user_id = ? AND status = "cancelled" ORDER BY resolved_at DESC LIMIT 1',
            [guildId, userId]
        );
        
        if (cancelledRequest) {
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply({ content: '**تم إلغاء هذا الطلب تلقائياً لأن العضو بدأ سلسلة ستريك جديدة بالفعل**' });
            }
            return interaction.reply({ content: '**تم إلغاء هذا الطلب تلقائياً لأن العضو بدأ سلسلة ستريك جديدة بالفعل**', flags: 64 });
        }
        
        if (interaction.deferred || interaction.replied) {
            return interaction.editReply({ content: '**لا يوجد طلب استعادة قيد الانتظار لهذا المستخدم**' });
        }
        return interaction.reply({ content: '**لا يوجد طلب استعادة قيد الانتظار لهذا المستخدم**', flags: 64 });
    }

    await runQuery('UPDATE streak_restore_requests SET status = ?, approver_id = ?, resolved_at = strftime("%s", "now") WHERE id = ?',
        ['approved', interaction.user.id, request.id]);

    await runQuery('UPDATE streak_users SET current_streak = ?, is_active = 1 WHERE guild_id = ? AND user_id = ?',
        [request.previous_streak, guildId, userId]);

    const user = await client.users.fetch(userId).catch(() => null);
    if (user) {
        try {
            const approveDmEmbed = withEmbedAvatar(colorManager.createEmbed()
                .setTitle('**تمت الموافقة على استعادة الـ Streak**')
                .setDescription(`تم استعادة سلسلة الـ Streak الخاصة بك: **${request.previous_streak}** <:emoji_61:1442587727387427009>.\n\n**استمر في إرسال الصور يومياً**`)
                .setColor('#FFFFFF')
                .setFooter({ text: 'Streak System' }), interaction.user, 'Moderator');

            await user.send({ embeds: [approveDmEmbed] });
        } catch (dmErr) {
            console.log(`لا يمكن إرسال DM للمستخدم ${userId}`);
        }
    }

    const approveReplyEmbed = withEmbedAvatar(colorManager.createEmbed()
        .setTitle('**تمت الموافقة على الطلب**')
        .setDescription(`تمت الموافقة على استعادة الـ Streak للعضو <@${userId}>`), interaction.user, 'Moderator');

    await interaction.editReply({ embeds: [approveReplyEmbed] });

    if (interaction.message) {
        const disabledButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`streak_approve_restore_${guildId}_${userId}`)
                .setLabel('موافقة')
                .setStyle(ButtonStyle.Success)
                .setDisabled(true),
            new ButtonBuilder()
                .setCustomId(`streak_reject_restore_${guildId}_${userId}`)
                .setLabel('رفض')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(true)
        );
        await interaction.message.edit({ components: [disabledButtons] }).catch(() => {});
    }
}

async function handleRejectRestore(interaction, client, botOwners) {
    const [, , , guildId, userId] = interaction.customId.split('_');

    if (!guildId || !userId) {
        return interaction.reply({ content: '**تعذر تحديد بيانات الطلب**', flags: 64 });
    }

    const settings = await getSettings(guildId);
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!settings || !guild) {
        return interaction.reply({ content: '**تعذر تحميل إعدادات السيرفر**', flags: 64 });
    }

    const approvers = await getApprovers(settings, guild, botOwners || []);
    if (!approvers.includes(interaction.user.id)) {
        return interaction.reply({ content: '**ليس لديك صلاحية لرفض الطلب**', flags: 64 });
    }

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
    }

    const request = await getQuery(
        'SELECT * FROM streak_restore_requests WHERE guild_id = ? AND user_id = ? AND status = "pending" ORDER BY created_at DESC LIMIT 1',
        [guildId, userId]
    );

    if (!request) {
        // التحقق مما إذا كان الطلب قد تم إلغاؤه تلقائياً
        const cancelledRequest = await getQuery(
            'SELECT * FROM streak_restore_requests WHERE guild_id = ? AND user_id = ? AND status = "cancelled" ORDER BY resolved_at DESC LIMIT 1',
            [guildId, userId]
        );
        
        if (cancelledRequest) {
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply({ content: '**تم إلغاء هذا الطلب تلقائياً لأن العضو بدأ سلسلة ستريك جديدة بالفعل**' });
            }
            return interaction.reply({ content: '**تم إلغاء هذا الطلب تلقائياً لأن العضو بدأ سلسلة ستريك جديدة بالفعل**', flags: 64 });
        }
        
        if (interaction.deferred || interaction.replied) {
            return interaction.editReply({ content: '**لا يوجد طلب استعادة قيد الانتظار لهذا المستخدم**' });
        }
        return interaction.reply({ content: '**لا يوجد طلب استعادة قيد الانتظار لهذا المستخدم**', flags: 64 });
    }

    await runQuery('UPDATE streak_restore_requests SET status = ?, approver_id = ?, resolved_at = strftime("%s", "now") WHERE id = ?',
        ['rejected', interaction.user.id, request.id]);

    const user = await client.users.fetch(userId).catch(() => null);
    if (user) {
        try {
            const rejectDmEmbed = withEmbedAvatar(colorManager.createEmbed()
                .setTitle('**تم رفض طلب استعادة الـ Streak**')
                .setDescription(`تم رفض طلب استعادة الـ Streak من قبل المسؤولين.\n\n**يمكنك بدء سلسلة جديدة بإرسال صورة**`)
                .setFooter({ text: 'Streak System' }), interaction.user, 'Moderator');

            await user.send({ embeds: [rejectDmEmbed] });
        } catch (dmErr) {
            console.log(`لا يمكن إرسال DM للمستخدم ${userId}`);
        }
    }

    const rejectReplyEmbed = withEmbedAvatar(colorManager.createEmbed()
        .setTitle('**تم رفض الطلب**')
        .setDescription(`تم رفض طلب استعادة الـ Streak للعضو <@${userId}>`)
        .setColor('#FFFFFF'), interaction.user, 'Moderator');

    await interaction.editReply({ embeds: [rejectReplyEmbed] });

    if (interaction.message) {
        const disabledButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`streak_approve_restore_${guildId}_${userId}`)
                .setLabel('موافقة')
                .setStyle(ButtonStyle.Success)
                .setDisabled(true),
            new ButtonBuilder()
                .setCustomId(`streak_reject_restore_${guildId}_${userId}`)
                .setLabel('رفض')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(true)
        );
        await interaction.message.edit({ components: [disabledButtons] }).catch(() => {});
    }
}

function startStreakScheduler(client) {
    // فحص انتهاء الـ Streaks عند منتصف الليل (12:00 AM) بتوقيت الرياض
    schedule.scheduleJob({ hour: 0, minute: 0, tz: 'Asia/Riyadh' }, async () => {
        console.log('⏰ منتصف الليل بتوقيت الرياض - تشغيل فحص انتهاء الـ Streaks...');
        await checkStreakExpiration(client);
    });

    // إضافة مهمة للتحذيرات عند الساعة 10 مساءً بتوقيت الرياض (قبل ساعتين من منتصف الليل)
    schedule.scheduleJob({ hour: 22, minute: 0, tz: 'Asia/Riyadh' }, async () => {
        console.log('⏰ الساعة 10 مساءً بتوقيت الرياض - إرسال تحذيرات الـ Streaks...');
        await sendStreakWarnings(client);
    });

    console.log('✅ تم تشغيل مجدول فحص الـ Streaks (يومياً عند منتصف الليل 12:00 AM بتوقيت الرياض)');
    console.log('✅ تم تشغيل مجدول التحذيرات (يومياً عند 10:00 PM بتوقيت الرياض)');
}

async function setupEmojiCollector(message, settings) {
    if (!settings.reactionEmojis || settings.reactionEmojis.length === 0) return;

    // تنظيف Collectors القديمة (أكثر من ساعة)
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    for (const [msgId, collectorData] of messageCollectors.entries()) {
        if (now - collectorData.timestamp > oneHour) {
            collectorData.collector.stop();
            messageCollectors.delete(msgId);
        }
    }

    const filter = (reaction, user) => {
        return !user.bot && settings.reactionEmojis.some(emoji => {
            const emojiIdMatch = emoji.match(/<a?:\w+:(\d+)>/);
            if (emojiIdMatch) {
                return reaction.emoji.id === emojiIdMatch[1];
            }
            return reaction.emoji.name === emoji;
        });
    };

    // Collector لمدة 24 ساعة بدلاً من للأبد
    const collector = message.createReactionCollector({ filter, time: 24 * 60 * 60 * 1000 });

    collector.on('collect', async (reaction, user) => {
        console.log(`تم التفاعل على رسالة ${message.id} من ${user.tag}`);
    });

    collector.on('end', () => {
        messageCollectors.delete(message.id);
    });

    messageCollectors.set(message.id, { collector, timestamp: now });
}

module.exports = {
    name,
    description: 'نظام Streak المتكامل لتتبع نشاط الأعضاء اليومي',
    
    async initialize(client) {
        await initializeDatabase();
        startStreakScheduler(client);
        console.log('تم تهيئة نظام Streak بنجاح');
    },

    async execute(message, args, { BOT_OWNERS }) {
        // التأكد من تهيئة قاعدة البيانات
        if (!db) {
            console.log('⚠️ قاعدة البيانات غير مهيأة، محاولة التهيئة...');
            try {
                await initializeDatabase();
            } catch (error) {
                console.error('❌ فشل في تهيئة قاعدة البيانات:', error);
                return message.reply('❌ حدث خطأ في تهيئة نظام Streak');
            }
        }

        const guildId = message.guild.id;

        // إذا كان المستخدم يطلب الستريك الخاص به أو ستريك شخص آخر
        if (args.length > 0 || !BOT_OWNERS.includes(message.author.id)) {
            const targetUser = message.mentions.users.first() || message.author;
            const userStreak = await getUserStreak(guildId, targetUser.id);
            
            if (!userStreak) {
                return message.reply(`**${targetUser.username} ليس لديه سلسلة ستريك حالياً**`);
            }

            const embed = withEmbedAvatar(colorManager.createEmbed()
                .setTitle(`**Streak: ${targetUser.username}**`)
                .addFields(
                    { name: '**الستريك الحالي**', value: `${userStreak.current_streak} <:emoji_61:1442587727387427009>`, inline: true },
                    { name: '**أطول ستريك**', value: `${userStreak.longest_streak} <:emoji_60:1442587701474754760>`, inline: true },
                    { name: '**إجمالي الصور**', value: `${userStreak.total_posts || 0} 🖼️`, inline: true }
                )
                .setFooter({ text: 'Streak System' }), targetUser, 'Member');

            return message.reply({ embeds: [embed] });
        }

        const settings = await getSettings(guildId);
        const statusEmbed = createStatusEmbed(settings || {}, message.author);
        const mainButtons = createMainButtons();

        await message.channel.send({ embeds: [statusEmbed], components: [mainButtons] });
    },

    async handleInteraction(interaction, context) {
        console.log(`🔍 معالجة تفاعل Streak: ${interaction.customId}`);
        
        const { client, BOT_OWNERS = [] } = context || {};
        const customId = interaction.customId;
        
        // استخراج guildId من customId إذا كان التفاعل من DM
        let guildId = interaction.guild?.id;
        
        // للتفاعلات التي تأتي من DM (مثل طلب استعادة Streak)
        if (!guildId && customId.includes('_')) {
            const extractedGuildId = extractGuildIdFromCustomId(customId);
            if (extractedGuildId) {
                guildId = extractedGuildId;
                console.log(`✅ تم استخراج guildId من customId: ${guildId}`);
            }
        }
        
        // التحقق من وجود guildId للتفاعلات التي تحتاج إليه
        const needsGuildId = !customId.startsWith('streak_request_restore_');
        if (!guildId && needsGuildId) {
            console.log(`❌ لا يوجد guildId في التفاعل: ${customId}`);
            if (!interaction.replied && !interaction.deferred) {
                return interaction.reply({
                    content: '❌ حدث خطأ في معالجة التفاعل',
                    flags: 64
                }).catch(() => {});
            }
            return;
        }
        
        // التأكد من تهيئة قاعدة البيانات
        if (!db) {
            console.log('⚠️ قاعدة البيانات غير مهيأة في handleInteraction');
            try {
                await initializeDatabase();
                console.log('✅ تم تهيئة قاعدة البيانات في handleInteraction');
            } catch (error) {
                console.error('❌ فشل في تهيئة قاعدة البيانات:', error);
                if (!interaction.replied && !interaction.deferred) {
                    return interaction.reply({
                        content: '❌ حدث خطأ في تهيئة نظام Streak',
                        flags: 64
                    });
                }
                return;
            }
        }

        // معالجة Modal للسبب عند الحذف
        if (interaction.isModalSubmit() && customId.startsWith('streak_delete_reason_')) {
            return handleDeleteReasonModal(interaction, client, BOT_OWNERS);
        }
        
        // معالجة Modal للخط الفاصل
        if (interaction.isModalSubmit() && customId === 'streak_divider_modal') {
            const imageUrl = normalizeDividerUrl(interaction.fields.getTextInputValue('divider_url'));
            if (!imageUrl) {
                return interaction.reply({ content: '**الرابط غير صالح، تأكد أنه رابط صورة صحيح**', flags: 64 });
            }
            let settings = await getSettings(guildId) || {};
            const cachedPath = await cacheDividerImage(guildId, imageUrl);
            settings.dividerImageUrl = cachedPath ? `local:${cachedPath}` : imageUrl;
            await saveSettings(guildId, settings);
            
            const statusEmbed = createStatusEmbed(settings, interaction.user);
            const mainButtons = createMainButtons();
            
            await interaction.deferUpdate();
            await interaction.message.edit({ content: null, embeds: [statusEmbed], components: [mainButtons] });
            return;
        }
        
        // معالجة Modal للإيموجيات
        if (interaction.isModalSubmit() && customId === 'streak_emojis_modal') {
            const emojisString = interaction.fields.getTextInputValue('emojis_list');
            const emojis = emojisString.trim().split(/\s+/);
            let settings = await getSettings(guildId) || {};
            settings.reactionEmojis = emojis;
            await saveSettings(guildId, settings);
            
            const statusEmbed = createStatusEmbed(settings, interaction.user);
            const mainButtons = createMainButtons();
            
            await interaction.deferUpdate();
            await interaction.message.edit({ content: null, embeds: [statusEmbed], components: [mainButtons] });
            return;
        }

        if (customId.startsWith('streak_show_top_reaction_')) {
            return handleShowTopReactionImage(interaction);
        }

        if (customId.startsWith('streak_follow_') && customId.split('_').length === 3) {
            return handleFollowButton(interaction, client);
        }

        if (customId.startsWith('streak_follow_yes_')) {
            return handleFollowConfirmation(interaction, client, 'named');
        }

        if (customId.startsWith('streak_follow_anon_')) {
            return handleFollowConfirmation(interaction, client, 'anon');
        }

        if (customId.startsWith('streak_unfollow_yes_')) {
            return handleUnfollowConfirmation(interaction, client);
        }

        if (customId.startsWith('streak_follow_cancel_')) {
            return interaction.update({ content: '**تم إلغاء العملية**', components: [] });
        }

        if (customId.startsWith('streak_delete_')) {
            return handleDividerDelete(interaction, BOT_OWNERS);
        }

        if (customId.startsWith('streak_request_restore_')) {
            return handleRestoreRequest(interaction, client, BOT_OWNERS);
        }

        if (customId.startsWith('streak_approve_restore_')) {
            return handleApproveRestore(interaction, client, BOT_OWNERS);
        }

        if (customId.startsWith('streak_reject_restore_')) {
            return handleRejectRestore(interaction, client, BOT_OWNERS);
        }

        // التحقق من الصلاحيات لجميع التفاعلات ما عدا طلبات الاستعادة
        if (!customId.startsWith('streak_request_restore_') && 
            !customId.startsWith('streak_approve_restore_') && 
            !customId.startsWith('streak_reject_restore_') &&
            !customId.startsWith('streak_follow_') &&
            !customId.startsWith('streak_unfollow_yes_') &&
            !customId.startsWith('streak_show_top_reaction_')) {
            if (!BOT_OWNERS.includes(interaction.user.id)) {
                if (!interaction.replied && !interaction.deferred) {
                    return interaction.reply({ content: '** يالليل لا تضغط **', flags: 64 });
                }
                return;
            }
        }

        let settings = await getSettings(guildId) || {};

        if (customId === 'streak_back_to_main') {
            settings = await getSettings(guildId) || {};
            const statusEmbed = createStatusEmbed(settings, interaction.user);
            const mainButtons = createMainButtons();
            if (!interaction.replied && !interaction.deferred) {
                return interaction.update({ content: null, embeds: [statusEmbed], components: [mainButtons] });
            }
            return;
        }

        if (customId === 'streak_set_approvers') {
            const approverButtons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId('streak_approver_owners').setLabel('المالكين').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('streak_approver_role').setLabel('رول').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('streak_approver_resp').setLabel('مسؤولية').setStyle(ButtonStyle.Success),
                    createBackButton()
                );
            return interaction.update({ content: '**اختر نوع المعتمدين:**', embeds: [], components: [approverButtons] });
        }

        if (customId === 'streak_approver_owners') {
            settings.approverType = 'owners';
            settings.approverTargets = [];
            await saveSettings(guildId, settings);
            const statusEmbed = createStatusEmbed(settings, interaction.user);
            const mainButtons = createMainButtons();
            return interaction.update({ content: null, embeds: [statusEmbed], components: [mainButtons] });
        }

        if (customId === 'streak_approver_role') {
            const roleMenu = new RoleSelectMenuBuilder()
                .setCustomId('streak_role_select')
                .setPlaceholder('اختر الأدوار المعتمدة')
                .setMinValues(1)
                .setMaxValues(10);
            const menuRow = new ActionRowBuilder().addComponents(roleMenu);
            const backRow = new ActionRowBuilder().addComponents(createBackButton());
            return interaction.update({ content: '**اختر الأدوار:**', embeds: [], components: [menuRow, backRow] });
        }

        if (customId === 'streak_approver_resp') {
            const responsibilities = readJsonFile(responsibilitiesPath, {});
            const respNames = Object.keys(responsibilities);
            
            if (respNames.length === 0) {
                const statusEmbed = createStatusEmbed(settings, interaction.user);
                const mainButtons = createMainButtons();
                return interaction.update({ content: '**لا توجد مسؤوليات محددة**', embeds: [statusEmbed], components: [mainButtons] });
            }

            const pagination = createPaginatedResponsibilityArray(respNames, 0, 'streak_resp_select', 'اختر المسؤولية');
            const backRow = new ActionRowBuilder().addComponents(createBackButton());
            const allComponents = [...pagination.components, backRow];
            return interaction.update({ content: '**اختر المسؤولية:**', embeds: [], components: allComponents });
        }

        if (interaction.isRoleSelectMenu() && customId === 'streak_role_select') {
            settings.approverType = 'role';
            settings.approverTargets = interaction.values;
            await saveSettings(guildId, settings);
            const statusEmbed = createStatusEmbed(settings, interaction.user);
            const mainButtons = createMainButtons();
            return interaction.update({ content: null, embeds: [statusEmbed], components: [mainButtons] });
        }

        if (interaction.isStringSelectMenu() && customId === 'streak_resp_select') {
            settings.approverType = 'responsibility';
            settings.approverTargets = interaction.values;
            await saveSettings(guildId, settings);
            const statusEmbed = createStatusEmbed(settings, interaction.user);
            const mainButtons = createMainButtons();
            return interaction.update({ content: null, embeds: [statusEmbed], components: [mainButtons] });
        }

        if (customId === 'streak_set_channel') {
            const channelMenu = new ChannelSelectMenuBuilder()
                .setCustomId('streak_channel_select')
                .setPlaceholder('اختر روم اللوكيت')
                .addChannelTypes(ChannelType.GuildText);
            const menuRow = new ActionRowBuilder().addComponents(channelMenu);
            const backRow = new ActionRowBuilder().addComponents(createBackButton());
            return interaction.update({ content: '**اختر روم اللوكيت:**', embeds: [], components: [menuRow, backRow] });
        }

        if (interaction.isChannelSelectMenu() && customId === 'streak_channel_select') {
            settings.lockedChannelId = interaction.values[0];
            await saveSettings(guildId, settings);
            const statusEmbed = createStatusEmbed(settings, interaction.user);
            const mainButtons = createMainButtons();
            return interaction.update({ content: null, embeds: [statusEmbed], components: [mainButtons] });
        }

        if (customId === 'streak_set_divider') {
            const modal = new ModalBuilder()
                .setCustomId('streak_divider_modal')
                .setTitle('تحديد صورة الخط الفاصل');

            const urlInput = new TextInputBuilder()
                .setCustomId('divider_url')
                .setLabel('رابط صورة الخط الفاصل')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder('https://example.com/image.png');

            modal.addComponents(new ActionRowBuilder().addComponents(urlInput));
            return interaction.showModal(modal);
        }

        if (customId === 'streak_set_emojis') {
            const modal = new ModalBuilder()
                .setCustomId('streak_emojis_modal')
                .setTitle('تحديد الإيموجيات');

            const emojisInput = new TextInputBuilder()
                .setCustomId('emojis_list')
                .setLabel('أرسل الإيموجيات (مفصولة بمسافة)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder('لازم من السيرفر');

            modal.addComponents(new ActionRowBuilder().addComponents(emojisInput));
            return interaction.showModal(modal);
        }
    },

    async handleMessage(message, client, botOwners) {
        await handleLockedRoomMessage(message, client, botOwners);
    },

    async handleMessageDelete(message, client) {
        try {
            if (!db) {
                try {
                    await initializeDatabase();
                } catch (error) {
                    console.error('❌ فشل في تهيئة قاعدة البيانات أثناء حذف رسالة Streak:', error);
                    return;
                }
            }
            // استخدام guildId و channelId بدلاً من guild و channel لدعم partial messages
            const guildId = message.guildId || message.guild?.id;
            const channelId = message.channelId || message.channel?.id;
            const messageId = message.id;
            
            // التحقق من وجود معلومات أساسية
            if (!guildId || !channelId || !messageId) {
                console.log(`⚠️ رسالة محذوفة بدون معلومات كافية`);
                return;
            }

            const settings = await getSettings(guildId);
            
            // التحقق من وجود إعدادات وروم لوكيت محدد
            if (!settings || !settings.lockedChannelId) return;
            
            // التحقق من أن الرسالة المحذوفة في روم اللوكيت
            if (channelId !== settings.lockedChannelId) return;

            console.log(`🗑️ تم حذف رسالة في روم اللوكيت - ID: ${messageId}`);

            // البحث عن الخط الفاصل المرتبط بهذه الرسالة
            const divider = await getQuery(
                'SELECT * FROM streak_dividers WHERE user_message_ids LIKE ?',
                [`%"${messageId}"%`]
            );

            if (divider) {
                console.log(`🎯 وجدنا خط فاصل مرتبط بالرسالة المحذوفة - Divider ID: ${divider.message_id}`);
                
                // حذف الخط الفاصل
                try {
                    const channel = await client.channels.fetch(divider.channel_id).catch(() => null);
                    if (channel) {
                        const dividerMessage = await channel.messages.fetch(divider.message_id).catch(() => null);
                        if (dividerMessage) {
                            const wasDeleted = await safeDeleteMessage(dividerMessage, `خط فاصل ${divider.message_id}`);
                            if (wasDeleted) {
                                console.log(`✅ تم حذف الخط الفاصل - ID: ${divider.message_id}`);
                            }
                        } else {
                            console.log(`⚠️ الخط الفاصل غير موجود في الكاش - ربما محذوف مسبقاً`);
                        }
                    }
                } catch (deleteError) {
                    if (isIgnorableDiscordError(deleteError)) {
                        console.log(`ℹ️ تم تجاهل خطأ متوقع أثناء حذف الخط الفاصل ${divider.message_id}: ${deleteError.message}`);
                    } else {
                        console.error(`❌ فشل في حذف الخط الفاصل:`, deleteError.message);
                    }
                }

                // حذف السجل من قاعدة البيانات في جميع الأحوال
                await runQuery('DELETE FROM streak_dividers WHERE message_id = ?', [divider.message_id]);
                console.log(`🗄️ تم حذف سجل الخط الفاصل من قاعدة البيانات`);
            } else {
                console.log(`ℹ️ لم يتم العثور على خط فاصل مرتبط بالرسالة المحذوفة`);
            }
        } catch (error) {
            console.error('❌ خطأ في معالجة حذف رسالة Streak:', error);
        }
    }
};
