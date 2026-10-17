const { ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const colorManager = require('../utils/colorManager');
const downManager = require('../utils/downManager');
const { buildTopSummaryImage } = require('../utils/topSummaryRenderer');
const { getGuildBannerHex } = require('../utils/guildBannerColor');

const name = 'داوناتي';
const PAGE_SIZE = 1;
const imageCache = new Map();
const CACHE_TTL_MS = 15 * 1000;

function getTargetId(message, args, canViewOthers = false) {
    if (!args?.length || !canViewOthers) return message.author.id;
    const raw = args[0].replace(/[<@!>]/g, '');
    return /^\d{16,20}$/.test(raw) ? raw : message.author.id;
}

async function collectHistory(userId, guild) {
    const records = [];
    const activeDowns = downManager.getUserDowns(userId, guild.id);
    const logs = downManager.getUserDownHistory(userId, guild.id);
    const roleCache = new Map();
    const getRoleName = async roleId => {
        if (!roleId) return 'Verbal Warning';
        if (roleCache.has(roleId)) return roleCache.get(roleId);
        const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
        const name = role?.name || 'Deleted Role';
        roleCache.set(roleId, name);
        return name;
    };

    for (const log of logs) {
        const data = log.data || {};
        const verbal = log.type === 'DOWN_VERBAL' || data.roleId === null || data.duration === 'شفوي' || data.duration === 'verbal';
        const isActive = !verbal && log.type === 'DOWN_APPLIED' && activeDowns.some(down =>
            down.roleId === data.roleId && Math.abs((down.startTime || down.timestamp || 0) - (log.timestamp || data.timestamp || 0)) <= 10 * 60 * 1000
        );
        records.push({
            action: isActive ? 'Active now' : (log.type === 'DOWN_ENDED' ? 'Ended' : (verbal ? 'Verbal warning' : 'Inactive')),
            roleName: await getRoleName(verbal ? null : data.roleId),
            duration: verbal ? 'Verbal' : (data.duration || 'Permanent'),
            reason: data.reason || data.originalReason || 'Unspecified',
            moderatorId: data.byUserId || data.modifiedBy,
            timestamp: log.timestamp || data.timestamp || Date.now(),
            endTime: null,
            active: isActive
        });
    }

    for (const down of activeDowns) {
        const hasAppliedLog = logs.some(log => log.type === 'DOWN_APPLIED' && log.data?.roleId === down.roleId);
        if (hasAppliedLog) continue;
        records.push({
            action: 'Active now',
            roleName: await getRoleName(down.roleId),
            duration: down.duration || 'Permanent',
            reason: down.reason || 'Unspecified',
            moderatorId: down.byUserId,
            timestamp: down.startTime || down.timestamp || Date.now(),
            endTime: down.endTime || null,
            active: true
        });
    }
    return records.sort((a, b) => b.timestamp - a.timestamp);
}

function buildComponents(viewerId, targetId, page, totalPages) {
    if (totalPages <= 1) return [];
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`down_my_history_prev_${viewerId}_${targetId}_${page}`).setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(`down_my_history_next_${viewerId}_${targetId}_${page}`).setLabel('التالي').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
    )];
}

async function buildHistoryImage(guild, client, user, targetMember, record, page, totalPages, accentColor) {
    const moderator = record.moderatorId
        ? (client.users.cache.get(record.moderatorId) || await client.users.fetch(record.moderatorId, { force: true }).catch(() => null))
        : null;
    const moderatorName = moderator?.globalName || moderator?.username || 'Unknown';
    const timestamp = new Date(record.timestamp);
    const dateText = Number.isNaN(timestamp.getTime()) ? 'Unknown' : timestamp.toLocaleString('en-US');
    const endText = record.endTime ? new Date(record.endTime).toLocaleString('en-US') : 'Permanent';
    const key = JSON.stringify({ guild: guild.id, user: user?.id, page, totalPages, record, accentColor });
    const cached = imageCache.get(key);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) return new AttachmentBuilder(Buffer.from(cached.buffer), { name: 'down-history.png' });
    const image = buildTopSummaryImage({
        accentColor,
        title: 'Down History',
        subtitle: `${targetMember?.displayName || user?.globalName || user?.username || 'Member'} • Page ${page + 1} of ${totalPages}`,
        sections: [{
            title: `Record ${page + 1} • ${record.roleName}`,
            rows: [
                { label: 'Status', value: record.active ? 'Active now' : record.action },
                { label: 'Duration', value: String(record.duration).slice(0, 70) },
                { label: 'Reason', value: String(record.reason).slice(0, 70) },
                { label: 'By', value: moderatorName },
                { label: 'Date', value: dateText },
                { label: 'Ends', value: endText }
            ]
        }],
        yourRank: `Record :  #${page + 1}   •   Total :  ${totalPages}`
    });
    const buffer = image.attachment;
    imageCache.set(key, { buffer, createdAt: Date.now() });
    if (imageCache.size > 100) imageCache.delete(imageCache.keys().next().value);
    return new AttachmentBuilder(Buffer.from(buffer), { name: 'down-history.png' });
}

async function sendHistory(message, context, targetId, viewerId, page = 0, interaction = null) {
    const guild = message?.guild || interaction?.guild;
    if (!guild) return;
    const targetMember = await guild.members.fetch({ user: targetId, force: true }).catch(() => null);
    if (!targetMember) {
        const payload = { content: '❌ **العضو غير موجود في هذا السيرفر.**', components: [] };
        return interaction ? interaction.update(payload) : message.reply(payload);
    }
    const [user, records, accentColor] = await Promise.all([
        context.client.users.fetch(targetId, { force: true }).catch(() => null),
        collectHistory(targetId, guild),
        getGuildBannerHex(guild, colorManager.getColor?.() || '#5865F2')
    ]);
    if (!records.length) {
        const payload = { content: targetId === viewerId ? '❌ **ليس لديك أي سجل داون.**' : `❌ **<@${targetId}> ليس لديه أي سجل داون.**`, components: [] };
        return interaction ? interaction.update(payload) : message.reply({ ...payload, allowedMentions: { users: [targetId] } });
    }
    const totalPages = Math.ceil(records.length / PAGE_SIZE);
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const image = await buildHistoryImage(guild, context.client, user, targetMember, records[safePage], safePage, totalPages, accentColor);
    const payload = { files: [image], components: buildComponents(viewerId, targetId, safePage, totalPages) };
    return interaction ? interaction.update(payload) : message.reply(payload);
}

module.exports = {
    name,
    description: 'عرض سجل الداون الخاص بك أو سجل عضو بالمنشن للمالك',
    async execute(message, args, context) {
        const owners = (context.BOT_OWNERS || []).map(String);
        const canViewOthers = owners.includes(message.author.id) || await downManager.hasPermission({ user: message.author, member: message.member, guild: message.guild }, owners);
        const targetId = getTargetId(message, args, canViewOthers);
        if (targetId !== message.author.id && !canViewOthers) {
            return message.reply('❌ **عرض سجل عضو آخر متاح للمالك والمصرح لهم في نظام الداون. استخدم `داوناتي` لعرض سجلك.**');
        }
        return sendHistory(message, context, targetId, message.author.id);
    },
    async handleInteraction(interaction, context) {
        const match = interaction.customId.match(/^down_my_history_(prev|next)_(\d{16,20})_(\d{16,20})_(\d+)$/);
        if (!match || interaction.user.id !== match[2]) return interaction.reply({ content: '❌ **هذا الزر مخصص لصاحب عرض السجل.**', flags: 64 });
        const page = match[1] === 'prev' ? Number(match[4]) - 1 : Number(match[4]) + 1;
        return sendHistory(null, context, match[3], interaction.user.id, page, interaction);
    },
    collectHistory
};
