const { AttachmentBuilder } = require('discord.js');
const colorManager = require('../utils/colorManager');
const downManager = require('../utils/downManager');
const { buildTopSummaryImage } = require('../utils/topSummaryRenderer');
const { getGuildBannerHex } = require('../utils/guildBannerColor');

const imageCache = new Map();
const CACHE_TTL_MS = 15 * 1000;

function formatTimeLeft(endTime) {
    if (!endTime) return 'Permanent';
    const remaining = Number(endTime) - Date.now();
    if (remaining <= 0) return 'Ended';
    const seconds = Math.floor(remaining / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes}m`;
    return `${Math.max(1, minutes)}m`;
}

function downNumber(down) {
    return down.id?.split('_').pop() || down.downId?.split('_').pop() || 'N/A';
}

async function resolveTarget(message, client, args, canViewOthers) {
    let targetUser = message.author;
    let targetId = message.author.id;
    if (canViewOthers && args?.[0]) {
        const requestedId = args[0].replace(/[<@!>]/g, '');
        targetUser = message.mentions.users.first()
            || client.users.cache.get(requestedId)
            || await client.users.fetch(requestedId, { force: true }).catch(() => null);
        if (targetUser) targetId = targetUser.id;
    }
    const [user, member] = await Promise.all([
        targetId === message.author.id ? Promise.resolve(message.author) : client.users.fetch(targetId, { force: true }).catch(() => targetUser),
        targetId === message.author.id ? Promise.resolve(message.member) : message.guild.members.fetch({ user: targetId, force: true }).catch(() => null)
    ]);
    return { targetId, targetUser: user || targetUser || message.author, targetMember: member };
}

async function buildDownImage(message, client, targetId, targetUser, targetMember, activeDowns, accentColor) {
    const cacheKey = JSON.stringify({
        guildId: message.guild.id,
        targetId,
        accentColor,
        downs: activeDowns.map(down => ({ id: down.id, roleId: down.roleId, endTime: down.endTime, reason: down.reason, byUserId: down.byUserId }))
    });
    const cached = imageCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
        return new AttachmentBuilder(Buffer.from(cached.buffer), { name: 'down-summary.png' });
    }

    const roleIds = [...new Set(activeDowns.map(down => down.roleId).filter(Boolean))];
    const moderatorIds = [...new Set(activeDowns.map(down => down.byUserId).filter(Boolean))];
    const [roles, moderators] = await Promise.all([
        Promise.all(roleIds.map(async id => [id, message.guild.roles.cache.get(id) || await message.guild.roles.fetch(id).catch(() => null)])),
        Promise.all(moderatorIds.map(async id => [id, client.users.cache.get(id) || await client.users.fetch(id, { force: true }).catch(() => null)]))
    ]);
    const roleMap = new Map(roles);
    const moderatorMap = new Map(moderators);
    const sections = activeDowns.length ? activeDowns.map(down => {
        const role = down.roleId ? roleMap.get(down.roleId) : null;
        const moderator = down.byUserId ? moderatorMap.get(down.byUserId) : null;
        const roleName = role?.name || (down.roleId ? 'Deleted Role' : 'Verbal Warning');
        const moderatorName = moderator?.globalName || moderator?.username || 'Unknown';
        return {
            title: `Down #${downNumber(down)} • ${roleName}`,
            rows: [
                { label: 'Time Remaining', value: formatTimeLeft(down.endTime) },
                { label: 'By', value: moderatorName },
                { label: 'Reason', value: String(down.reason || 'No reason').slice(0, 70) }
            ]
        };
    }) : [{ title: 'Status', rows: [{ label: 'Active Downs', value: 'None' }] }];

    const memberName = targetMember?.displayName || targetUser?.globalName || targetUser?.username || 'Member';
    const image = buildTopSummaryImage({
        accentColor,
        title: 'My Downs',
        subtitle: `Downs for ${memberName} • ${message.guild.name}`,
        sections,
        yourRank: `Active Downs :  ${activeDowns.length}   •   Status :  ${activeDowns.length ? 'Active' : 'Clear'}`
    });
    const buffer = image.attachment;
    imageCache.set(cacheKey, { buffer, createdAt: Date.now() });
    if (imageCache.size > 100) imageCache.delete(imageCache.keys().next().value);
    return new AttachmentBuilder(Buffer.from(buffer), { name: 'down-summary.png' });
}

module.exports = {
    name: 'داوني',
    description: 'عرض معلومات عن الداونات النشطة الخاصة بك',
    async execute(message, args, context) {
        try {
            const { BOT_OWNERS = [], client } = context;
            const isOwner = BOT_OWNERS.includes(message.author.id);
            const canViewOthers = isOwner || await downManager.hasPermission({
                user: message.author,
                member: message.member,
                guild: message.guild
            }, BOT_OWNERS);
            const { targetId, targetUser, targetMember } = await resolveTarget(message, client, args, canViewOthers);
            const isTargetingOther = targetId !== message.author.id;
            const activeDowns = downManager.getUserDowns(targetId, message.guild?.id);
            if (!activeDowns.length && isTargetingOther && !canViewOthers) return message.react('❌').catch(() => null);
            const accentColor = await getGuildBannerHex(message.guild, colorManager.getColor?.() || '#5865F2');
            const image = await buildDownImage(message, client, targetId, targetUser, targetMember, activeDowns, accentColor);
            return message.reply({ files: [image] });
        } catch (error) {
            console.error('Error in my-downs command:', error);
            return message.channel?.send('⚠️ حدث خطأ غير متوقع أثناء معالجة الطلب.').catch(() => null);
        }
    }
};
