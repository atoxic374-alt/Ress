const { AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { createCanvas, loadImage } = require('canvas');
const moment = require('moment-timezone');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { getCustomProfile } = require('./myprofile.js');

const name = 'ستريكي';

const dbPath = path.join(__dirname, '..', 'database', 'streak.db');
let db = null;
const REACTION_SEARCH_HISTORY_LIMIT = 80;

function initializeDatabase() {
    return new Promise((resolve, reject) => {
        const dbDir = path.dirname(dbPath);
        if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

        db = new sqlite3.Database(dbPath, async (err) => {
            if (err) {
                console.error('خطأ في فتح قاعدة بيانات streak (mystreak):', err);
                return reject(err);
            }

            try {
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
                    created_at INTEGER DEFAULT (strftime('%s', 'now')),
                    PRIMARY KEY (guild_id, user_id)
                )`);

                await runQuery(`CREATE TABLE IF NOT EXISTS streak_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    guild_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    message_id TEXT,
                    post_date TEXT NOT NULL,
                    streak_count INTEGER,
                    created_at INTEGER DEFAULT (strftime('%s', 'now'))
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

                resolve();
            } catch (tableError) {
                reject(tableError);
            }
        });
    });
}

function runQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('قاعدة البيانات غير مهيأة'));
        db.run(sql, params, function(err) { if (err) reject(err); else resolve(this); });
    });
}

function getQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('قاعدة البيانات غير مهيأة'));
        db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); });
    });
}

function allQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('قاعدة البيانات غير مهيأة'));
        db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
    });
}

async function getSettings(guildId) {
    const row = await getQuery('SELECT * FROM streak_settings WHERE guild_id = ?', [guildId]);
    if (!row) return null;
    return { lockedChannelId: row.locked_channel_id };
}

async function getUserStreak(guildId, userId) {
    return getQuery('SELECT * FROM streak_users WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
}

function getTimeUntilMidnightText() {
    const now = moment().tz('Asia/Riyadh');
    const midnight = moment().tz('Asia/Riyadh').endOf('day');
    const duration = moment.duration(midnight.diff(now));
    return `${Math.floor(duration.asHours())}h ${duration.minutes()}m ${duration.seconds()}s`;
}

function resolveLocalAssetPath(assetUrl) {
    if (!assetUrl || !assetUrl.startsWith('/')) return null;

    const baseDir = path.resolve(path.join(__dirname, '..', 'data'));
    const requestedPath = path.resolve(path.join(__dirname, '..', `.${assetUrl}`));

    if (!requestedPath.startsWith(baseDir + path.sep)) {
        return null;
    }

    return fs.existsSync(requestedPath) ? requestedPath : null;
}

function drawRoundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function drawFlameIcon(ctx, cx, cy, isActive) {
    if (!isActive) {
        // شمعة مطفية بشكل واقعي
        const waxGrad = ctx.createLinearGradient(cx, cy - 8, cx, cy + 20);
        waxGrad.addColorStop(0, 'rgba(214, 224, 243, 0.9)');
        waxGrad.addColorStop(1, 'rgba(162, 176, 206, 0.86)');
        ctx.fillStyle = waxGrad;
        ctx.beginPath();
        ctx.roundRect(cx - 11, cy - 2, 22, 26, 6);
        ctx.fill();

        // فتيل دخاني صغير
        ctx.strokeStyle = 'rgba(90,98,120,0.95)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy - 10);
        ctx.bezierCurveTo(cx + 2, cy - 14, cx + 4, cy - 10, cx + 1, cy - 6);
        ctx.stroke();

        // هالة خافتة جداً (بدون لهب)
        const dimAura = ctx.createRadialGradient(cx, cy - 3, 1, cx, cy - 3, 11);
        dimAura.addColorStop(0, 'rgba(175, 190, 220, 0.22)');
        dimAura.addColorStop(1, 'rgba(175, 190, 220, 0)');
        ctx.fillStyle = dimAura;
        ctx.beginPath();
        ctx.arc(cx, cy - 3, 11, 0, Math.PI * 2);
        ctx.fill();
        return;
    }

    ctx.save();
    ctx.shadowColor = 'rgba(255, 168, 72, 0.82)';
    ctx.shadowBlur = 24;

    // جسم الشمعة المنوّرة
    const waxBody = ctx.createLinearGradient(cx, cy - 4, cx, cy + 24);
    waxBody.addColorStop(0, 'rgba(249, 240, 221, 0.95)');
    waxBody.addColorStop(1, 'rgba(226, 205, 173, 0.9)');
    ctx.fillStyle = waxBody;
    ctx.beginPath();
    ctx.roundRect(cx - 11, cy - 1, 22, 25, 6);
    ctx.fill();

    // ذوبان بسيط على الحواف
    ctx.fillStyle = 'rgba(255, 241, 214, 0.35)';
    ctx.beginPath();
    ctx.ellipse(cx - 7, cy + 4, 2.2, 5.2, -0.2, 0, Math.PI * 2);
    ctx.ellipse(cx + 6, cy + 7, 2, 4.5, 0.25, 0, Math.PI * 2);
    ctx.fill();

    // الفتيل
    ctx.strokeStyle = 'rgba(72,58,45,0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 8);
    ctx.bezierCurveTo(cx + 1, cy - 12, cx + 1, cy - 12, cx, cy - 6);
    ctx.stroke();

    // اللهب
    const outer = ctx.createLinearGradient(cx, cy - 30, cx, cy + 26);
    outer.addColorStop(0, '#fff0b0');
    outer.addColorStop(0.35, '#ffb24a');
    outer.addColorStop(1, '#ff6436');
    ctx.fillStyle = outer;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 26);
    ctx.bezierCurveTo(cx + 12, cy - 16, cx + 14, cy + 0, cx, cy + 12);
    ctx.bezierCurveTo(cx - 12, cy + 0, cx - 13, cy - 16, cx, cy - 26);
    ctx.fill();

    const inner = ctx.createRadialGradient(cx, cy - 2, 1, cx, cy + 2, 10);
    inner.addColorStop(0, '#fffef1');
    inner.addColorStop(1, '#ffd86a');
    ctx.fillStyle = inner;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 14);
    ctx.bezierCurveTo(cx + 6, cy - 7, cx + 6, cy + 2, cx, cy + 8);
    ctx.bezierCurveTo(cx - 6, cy + 2, cx - 6, cy - 7, cx, cy - 14);
    ctx.fill();

    ctx.globalAlpha = 0.4;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(cx - 3, cy - 7, 3, 5, 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}


function drawClockIcon(ctx, x, y) {
    ctx.save();
    ctx.strokeStyle = '#9ed0ff';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x, y, 24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - 12);
    ctx.moveTo(x, y);
    ctx.lineTo(x + 9, y + 6);
    ctx.stroke();
    ctx.restore();
}

function drawUsersIcon(ctx, x, y) {
    ctx.save();
    const grad = ctx.createLinearGradient(x - 18, y - 16, x + 20, y + 20);
    grad.addColorStop(0, '#cbe1ff');
    grad.addColorStop(1, '#90b3ff');
    ctx.fillStyle = grad;

    ctx.shadowColor = 'rgba(140,178,255,0.35)';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(x - 10, y - 10, 6.5, 0, Math.PI * 2);
    ctx.arc(x + 10, y - 10, 6.5, 0, Math.PI * 2);
    ctx.arc(x, y - 12, 7.2, 0, Math.PI * 2);
    ctx.fill();

    drawRoundedRect(ctx, x - 24, y - 2, 48, 12, 5);
    ctx.fill();

    ctx.globalAlpha = 0.32;
    ctx.fillStyle = '#ffffff';
    drawRoundedRect(ctx, x - 20, y, 40, 4, 3);
    ctx.fill();
    ctx.restore();
}

function drawStatsIcon(ctx, x, y) {
    ctx.save();
    ctx.fillStyle = '#eac5ff';
    ctx.fillRect(x - 20, y + 2, 8, 14);
    ctx.fillRect(x - 8, y - 6, 8, 22);
    ctx.fillRect(x + 4, y - 14, 8, 30);
    ctx.fillRect(x + 16, y - 2, 8, 18);
    ctx.restore();
}

function drawCardIcon(ctx, type, x, y, isActiveToday) {
    if (type === 'flame') return drawFlameIcon(ctx, x, y, isActiveToday);
    if (type === 'clock') return drawClockIcon(ctx, x, y);
    if (type === 'users') return drawUsersIcon(ctx, x, y);
    return drawStatsIcon(ctx, x, y);
}

async function getTopReactionStats(guild, channelId, userId) {
    if (!channelId) return { maxReactions: 0, bestMessage: null };

    const history = await allQuery(
        'SELECT message_id, created_at FROM streak_history WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?',
        [guild.id, userId, REACTION_SEARCH_HISTORY_LIMIT]
    );

    if (!history.length) return { maxReactions: 0, bestMessage: null };

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return { maxReactions: 0, bestMessage: null };

    let maxReactions = 0;
    let bestMessage = null;

    for (const row of history) {
        if (!row.message_id) continue;
        const msg = await channel.messages.fetch(row.message_id).catch(() => null);
        if (!msg) continue;

        const reactions = [...msg.reactions.cache.values()].reduce((sum, reaction) => sum + reaction.count, 0);
        if (reactions >= maxReactions) {
            maxReactions = reactions;
            bestMessage = msg;
        }
    }

    return { maxReactions, bestMessage };
}

async function buildStreakCanvas(message, userStreak, settings, targetUser, targetMember) {
    const width = 1000;
    const height = 380;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const customProfile = await getCustomProfile(targetUser.id).catch(() => ({}));

    const bannerPath = resolveLocalAssetPath(customProfile?.banner_url);
    if (bannerPath) {
        const banner = await loadImage(bannerPath).catch(() => null);
        if (banner) {
            ctx.drawImage(banner, 0, 0, width, height);
            ctx.fillStyle = 'rgba(0, 0, 0, 0.48)';
            ctx.fillRect(0, 0, width, height);
        }
    } else {
        const bgGradient = ctx.createLinearGradient(0, 0, width, height);
        bgGradient.addColorStop(0, '#0f1525');
        bgGradient.addColorStop(0.3, '#1a1f3a');
        bgGradient.addColorStop(0.6, '#2d3561');
        bgGradient.addColorStop(1, '#1e2442');
        ctx.fillStyle = bgGradient;
        ctx.fillRect(0, 0, width, height);

        // تأثيرات حياة إضافية عند عدم وجود بنر مخصص
        const lightPatches = [
            { x: 120, y: 70, r: 120, color: '124,169,255' },
            { x: 860, y: 80, r: 140, color: '170,130,255' },
            { x: 760, y: 320, r: 180, color: '96,140,240' }
        ];

        for (const patch of lightPatches) {
            const g = ctx.createRadialGradient(patch.x, patch.y, 0, patch.x, patch.y, patch.r);
            g.addColorStop(0, `rgba(${patch.color}, 0.25)`);
            g.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(patch.x, patch.y, patch.r, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.strokeStyle = 'rgba(180,210,255,0.09)';
        ctx.lineWidth = 1;
        for (let x = 0; x < width; x += 50) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x + 20, height);
            ctx.stroke();
        }
    }

    const radialBg = ctx.createRadialGradient(width / 2, height / 2, 30, width / 2, height / 2, 430);
    radialBg.addColorStop(0, 'rgba(85, 115, 210, 0.22)');
    radialBg.addColorStop(1, 'rgba(0, 0, 0, 0.32)');
    ctx.fillStyle = radialBg;
    ctx.fillRect(0, 0, width, height);

    const edgeShadow = ctx.createLinearGradient(0, 0, width, 0);
    edgeShadow.addColorStop(0, 'rgba(0,0,0,0.26)');
    edgeShadow.addColorStop(0.1, 'rgba(0,0,0,0)');
    edgeShadow.addColorStop(0.9, 'rgba(0,0,0,0)');
    edgeShadow.addColorStop(1, 'rgba(0,0,0,0.26)');
    ctx.fillStyle = edgeShadow;
    ctx.fillRect(0, 0, width, height);

    const avatarPath = resolveLocalAssetPath(customProfile?.avatar_url);
    const avatarUrl = avatarPath || targetUser.displayAvatarURL({ extension: 'png', size: 256 });
    const avatar = await loadImage(avatarUrl);

    const centerX = width / 2;
    const centerY = 192;
    const avatarSize = 142;
    const avatarRadius = avatarSize / 2;

    const avatarRingGrad = ctx.createLinearGradient(centerX - 80, centerY - 80, centerX + 80, centerY + 80);
    avatarRingGrad.addColorStop(0, '#89dcff');
    avatarRingGrad.addColorStop(0.5, '#9f8dff');
    avatarRingGrad.addColorStop(1, '#ffb3ef');
    ctx.save();
    ctx.shadowColor = 'rgba(125, 170, 255, 0.5)';
    ctx.shadowBlur = 16;
    ctx.lineWidth = 6;
    ctx.strokeStyle = avatarRingGrad;
    ctx.beginPath();
    ctx.arc(centerX, centerY, avatarRadius + 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX, centerY, avatarRadius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatar, centerX - avatarRadius, centerY - avatarRadius, avatarSize, avatarSize);
    ctx.restore();

    const displayName = targetMember?.displayName || targetUser.username;
    const nickname = displayName.length > 13 ? `${displayName.substring(0, 13)}...` : displayName;

    ctx.textAlign = 'center';
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 24px Arial';
    ctx.fillText('Streak Sys;', centerX, 38);

    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.font = '700 20px Arial';
    ctx.fillText(nickname, centerX + 1, centerY + 98);
    ctx.fillStyle = '#FFFFFF';
    ctx.shadowColor = 'rgba(255, 255, 255, 0.35)';
    ctx.shadowBlur = 3;
    ctx.fillText(nickname, centerX, centerY + 97);
    ctx.restore();

    ctx.fillStyle = '#D9DFF7';
    ctx.font = '600 14px Arial';
    ctx.fillText(`@${targetUser.username}`, centerX, centerY + 124);

    const today = moment().tz('Asia/Riyadh').format('YYYY-MM-DD');
    const isActiveToday = userStreak.last_post_date === today;

    const lastHistory = await getQuery(
        'SELECT created_at FROM streak_history WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1',
        [message.guild.id, targetUser.id]
    );

    const followersCountRow = await getQuery(
        'SELECT COUNT(*) AS total FROM streak_followers WHERE guild_id = ? AND target_user_id = ? AND is_active = 1',
        [message.guild.id, targetUser.id]
    );

    const { maxReactions } = await getTopReactionStats(message.guild, settings?.lockedChannelId, targetUser.id);
    const lastPostText = lastHistory?.created_at
        ? moment.unix(lastHistory.created_at).tz('Asia/Riyadh').format('YYYY-MM-DD')
        : 'No post yet';

    const cardData = [
        { side: 'left', y: 52, title: 'My Streaks', value: `${userStreak.current_streak}`, sub: isActiveToday ? 'Active today' : 'No post today', type: 'flame' },
        { side: 'right', y: 52, title: 'Last Pic', value: lastPostText, sub: `New day in : ${getTimeUntilMidnightText()}`, type: 'clock' },
        { side: 'left', y: 238, title: 'Followers', value: `${followersCountRow?.total || 0}`, sub: `Top reactions : ${maxReactions}`, type: 'users' },
        { side: 'right', y: 238, title: 'Activity', value: `All pic : ${userStreak.total_posts || 0}`, sub: `Longest : ${userStreak.longest_streak || 0}`, type: 'stats' }
    ];

    const minCardWidth = 300;
    const maxCardWidth = 352;
    const cardHeight = 104;

    function fitText(text, maxWidth, font, fallback = '...') {
        ctx.font = font;
        if (ctx.measureText(text).width <= maxWidth) return text;
        let t = text;
        while (t.length > 0 && ctx.measureText(`${t}${fallback}`).width > maxWidth) {
            t = t.slice(0, -1);
        }
        return `${t}${fallback}`;
    }

    function calcDynamicWidth(title, value, sub) {
        ctx.font = '700 18px Arial';
        const t = Math.min(ctx.measureText(title).width, 200);
        ctx.font = '700 20px Arial';
        const v = Math.min(ctx.measureText(value).width, 220);
        ctx.font = '500 13px Arial';
        const sb = Math.min(ctx.measureText(sub).width, 240);
        const raw = Math.max(t, v, sb) + 115;
        return Math.max(minCardWidth, Math.min(maxCardWidth, raw));
    }

    function drawConnector(targetX, targetY) {
        const dx = targetX - centerX;
        const dy = targetY - centerY;
        const len = Math.max(Math.hypot(dx, dy), 1);
        const startX = centerX + (dx / len) * (avatarRadius + 10);
        const startY = centerY + (dy / len) * (avatarRadius + 10);

        const c1x = startX + (dx > 0 ? 52 : -52);
        const c2x = targetX + (dx > 0 ? -42 : 42);

        ctx.save();
        ctx.strokeStyle = 'rgba(166, 198, 255, 0.5)';
        ctx.shadowColor = 'rgba(130, 170, 255, 0.3)';
        ctx.shadowBlur = 7;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.bezierCurveTo(c1x, startY, c2x, targetY, targetX, targetY);
        ctx.stroke();

        const angle = Math.atan2(targetY - startY, targetX - startX);
        const size = 6;
        ctx.fillStyle = 'rgba(192, 216, 255, 0.75)';
        ctx.beginPath();
        ctx.moveTo(targetX, targetY);
        ctx.lineTo(targetX - size * Math.cos(angle - Math.PI / 6), targetY - size * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(targetX - size * Math.cos(angle + Math.PI / 6), targetY - size * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    function drawInfoCard(card, layout) {
        const { x, cardWidth } = layout;

        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.35)';
        ctx.shadowBlur = 10;
        const outer = ctx.createLinearGradient(x - 2, card.y - 2, x + cardWidth + 2, card.y + cardHeight + 2);
        outer.addColorStop(0, 'rgba(105,152,255,0.22)');
        outer.addColorStop(1, 'rgba(201,123,255,0.20)');
        ctx.fillStyle = outer;
        drawRoundedRect(ctx, x - 2, card.y - 2, cardWidth + 4, cardHeight + 4, 16);
        ctx.fill();
        ctx.restore();

        const inner = ctx.createLinearGradient(x, card.y, x + cardWidth, card.y + cardHeight);
        inner.addColorStop(0, 'rgba(22,30,56,0.82)');
        inner.addColorStop(0.5, 'rgba(30,39,70,0.82)');
        inner.addColorStop(1, 'rgba(32,27,57,0.82)');
        ctx.fillStyle = inner;
        drawRoundedRect(ctx, x, card.y, cardWidth, cardHeight, 14);
        ctx.fill();

        ctx.strokeStyle = 'rgba(198,218,255,0.45)';
        ctx.lineWidth = 1;
        drawRoundedRect(ctx, x, card.y, cardWidth, cardHeight, 14);
        ctx.stroke();

        const splitX = x + 74;
        const splitGradient = ctx.createLinearGradient(splitX, card.y + 12, splitX, card.y + cardHeight - 12);
        splitGradient.addColorStop(0, 'rgba(255,255,255,0.18)');
        splitGradient.addColorStop(1, 'rgba(255,255,255,0.04)');
        ctx.strokeStyle = splitGradient;
        ctx.beginPath();
        ctx.moveTo(splitX, card.y + 12);
        ctx.lineTo(splitX, card.y + cardHeight - 12);
        ctx.stroke();

        drawCardIcon(ctx, card.type, x + 38, card.y + 52, isActiveToday);

        ctx.textAlign = 'left';
        ctx.fillStyle = '#F0F4FF';
        ctx.font = '700 18px Arial';
        ctx.fillText(fitText(card.title, cardWidth - 90, '700 18px Arial'), x + 88, card.y + 34);

        ctx.fillStyle = '#FFFFFF';
        ctx.font = '700 24px Arial';
        ctx.fillText(fitText(card.value, cardWidth - 98, '700 24px Arial'), x + 88, card.y + 66);

        ctx.fillStyle = '#D6DEFF';
        ctx.font = '500 13px Arial';
        ctx.fillText(fitText(card.sub, cardWidth - 98, '500 13px Arial'), x + 88, card.y + 90);
    }

    const layouts = cardData.map((card) => {
        const cardWidth = calcDynamicWidth(card.title, card.value, card.sub);
        const x = card.side === 'left' ? 24 : width - 24 - cardWidth;
        const anchorX = card.side === 'left' ? x + cardWidth : x;
        const anchorY = card.y + Math.floor(cardHeight / 2);
        return { x, cardWidth, anchorX, anchorY };
    });

    layouts.forEach((layout) => drawConnector(layout.anchorX, layout.anchorY));
    cardData.forEach((card, index) => drawInfoCard(card, layouts[index]));

    return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: `streak-canvas-${targetUser.id}.png` });
}


module.exports = {
    name,
    description: 'عرض معلومات الـ Streak لك أو لعضو آخر',

    async initialize() {
        await initializeDatabase();
    },

    async execute(message) {
        if (!db) await initializeDatabase();

        const guildId = message.guild.id;
        const args = message.content.trim().split(/\s+/).slice(1);

        let targetUser = message.mentions.users.first() || null;
        if (!targetUser && args[0] && /^\d{17,20}$/.test(args[0])) {
            targetUser = await message.client.users.fetch(args[0]).catch(() => null);
        }

        if (!targetUser) {
            targetUser = message.author;
        }

        const targetMember = await message.guild.members.fetch(targetUser.id).catch(() => null);
        const userStreak = await getUserStreak(guildId, targetUser.id);
        const settings = await getSettings(guildId);

        if (!userStreak) {
            return message.channel.send(`**${targetUser.username} ما بدأ ستريك بعد، لازم ينزل صورة في روم اللوكيت أولاً.**`);
        }

        const attachment = await buildStreakCanvas(message, userStreak, settings, targetUser, targetMember);
        const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`streak_show_top_reaction_${targetUser.id}_${message.author.id}`)
                .setLabel('Top Pic Reactions')
                .setEmoji('<:emoji_37:1476106469442060358>')
                .setStyle(ButtonStyle.Secondary)
        );

        return message.channel.send({ files: [attachment], components: [actionRow] });
    }
};
