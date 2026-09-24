const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const colorManager = require('../utils/colorManager');
const downManager = require('../utils/downManager');

const name = 'داوناتي';
const PAGE_SIZE = 1;

function getTargetId(message, args, canViewOthers = false) {
    if (!args?.length || !canViewOthers) return message.author.id;
    const raw = args[0].replace(/[<@!>]/g, '');
    if (!/^\d{16,20}$/.test(raw)) return message.author.id;
    return raw;
}

async function collectHistory(userId, guild) {
    const records = [];
    const activeDowns = downManager.getUserDowns(userId, guild.id);
    const logs = downManager.getUserDownHistory(userId, guild.id);
    for (const log of logs) {
        const data = log.data || {};
        const verbal = log.type === 'DOWN_VERBAL' || data.roleId === null || data.duration === 'شفوي' || data.duration === 'verbal';
        const isActive = !verbal && log.type === 'DOWN_APPLIED' && activeDowns.some(down =>
            down.roleId === data.roleId && Math.abs((down.startTime || down.timestamp || 0) - (log.timestamp || data.timestamp || 0)) <= 10 * 60 * 1000
        );
        let roleName = verbal ? 'تنبيه شفوي' : 'رول غير معروف';
        if (!verbal && data.roleId) {
            const role = await guild.roles.fetch(data.roleId).catch(() => null);
            roleName = role ? role.name : `رول محذوف (${data.roleId})`;
        }
        records.push({
            action: isActive ? 'نشط حاليًا' : (log.type === 'DOWN_ENDED' ? 'غير نشط — تم إنهاؤه' : (verbal ? 'غير نشط — تنبيه شفوي' : 'غير نشط')),
            roleName,
            duration: verbal ? 'شفوي' : (data.duration || 'نهائي'),
            reason: data.reason || data.originalReason || 'غير محدد',
            moderatorId: data.byUserId || data.modifiedBy,
            timestamp: log.timestamp || data.timestamp || Date.now(),
            endTime: null,
            active: isActive
        });
    }

    for (const down of activeDowns) {
        const hasAppliedLog = logs.some(log => log.type === 'DOWN_APPLIED' && log.data?.roleId === down.roleId);
        if (hasAppliedLog) continue;
        const role = down.roleId ? await guild.roles.fetch(down.roleId).catch(() => null) : null;
        records.push({
            action: 'داون نشط حاليًا',
            roleName: role ? role.name : (down.roleId ? `رول محذوف (${down.roleId})` : 'تنبيه شفوي'),
            duration: down.duration || 'نهائي',
            reason: down.reason || 'غير محدد',
            moderatorId: down.byUserId,
            timestamp: down.startTime || down.timestamp || Date.now(),
            endTime: down.endTime || null,
            active: true
        });
    }
    return records.sort((a, b) => b.timestamp - a.timestamp);
}

function buildEmbed(user, records, page, totalPages, targetId) {
    const start = page * PAGE_SIZE;
    const embed = colorManager.createEmbed()
        .setAuthor({ name: user?.tag || 'مستخدم غير معروف', iconURL: user?.displayAvatarURL?.({ dynamic: true }) || undefined })
        .setTitle(`سجل الداون — ${user ? user.tag : `<@${targetId}>`}`)
        .setDescription(`العضو: <@${targetId}>\nالصفحة **${page + 1} من ${totalPages}** • إجمالي السجلات: **${records.length}**`)
        .setTimestamp();

    for (const [index, record] of records.slice(start, start + PAGE_SIZE).entries()) {
        const timestamp = Math.floor(record.timestamp / 1000);
        const value = [
            `**الحالة:** ${record.active ? 'نشط حاليًا' : 'غير نشط'}`,
            `**الإجراء:** ${record.action}`,
            `**الرول:** ${record.roleName}`,
            `**المدة:** ${record.duration}`,
            `**السبب:** ${String(record.reason).slice(0, 700)}`,
            `**بواسطة:** ${record.moderatorId ? `<@${record.moderatorId}>` : 'غير معروف'}`,
            `**التاريخ:** <t:${timestamp}:F> (<t:${timestamp}:R>)`,
            record.endTime ? `**ينتهي:** <t:${Math.floor(record.endTime / 1000)}:R>` : ''
        ].filter(Boolean).join('\n');
        embed.addFields({ name: `سجل ${start + index + 1}`, value: `${value}\n\u200b`, inline: false });
    }
    return embed;
}

function buildComponents(viewerId, targetId, page, totalPages) {
    if (totalPages <= 1) return [];
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`down_my_history_prev_${viewerId}_${targetId}_${page}`).setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(`down_my_history_next_${viewerId}_${targetId}_${page}`).setLabel('التالي').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
    )];
}

async function sendHistory(message, context, targetId, viewerId, page = 0, interaction = null) {
    const guild = message.guild || interaction?.guild;
    if (!guild) return;
    const targetMember = await guild.members.fetch(targetId).catch(() => null);
    if (!targetMember) {
        const payload = { content: '❌ **العضو غير موجود في هذا السيرفر.**', components: [] };
        return interaction ? interaction.update(payload) : message.reply(payload);
    }
    const user = await context.client.users.fetch(targetId).catch(() => null);
    const records = await collectHistory(targetId, guild);
    if (!records.length) {
        const payload = { content: targetId === viewerId ? '❌ **ليس لديك أي سجل داون.**' : `❌ **<@${targetId}> ليس لديه أي سجل داون.**`, components: [] };
        return interaction ? interaction.update(payload) : message.reply({ ...payload, allowedMentions: { users: [targetId] } });
    }
    const totalPages = Math.ceil(records.length / PAGE_SIZE);
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const payload = {
        embeds: [buildEmbed(user, records, safePage, totalPages, targetId)],
        components: buildComponents(viewerId, targetId, safePage, totalPages),
        allowedMentions: { users: [targetId], roles: [] }
    };
    return interaction ? interaction.update(payload) : message.reply(payload);
}

module.exports = {
    name,
    description: 'عرض سجل الداون الخاص بك أو سجل عضو بالمنشن للمالك',
    async execute(message, args, context) {
        const owners = (context.BOT_OWNERS || []).map(String);
        const canViewOthers = owners.includes(message.author.id) || await downManager.hasPermission({
            user: message.author,
            member: message.member,
            guild: message.guild
        }, owners);
        const targetId = getTargetId(message, args, canViewOthers);
        const isMentionOther = targetId !== message.author.id;
        if (isMentionOther && !canViewOthers) {
            return message.reply('❌ **عرض سجل عضو آخر متاح للمالك والمصرح لهم في نظام الداون. استخدم `داوناتي` لعرض سجلك.**');
        }
        return sendHistory(message, context, targetId, message.author.id);
    },
    async handleInteraction(interaction, context) {
        const match = interaction.customId.match(/^down_my_history_(prev|next)_(\d{16,20})_(\d{16,20})_(\d+)$/);
        if (!match || interaction.user.id !== match[2]) {
            return interaction.reply({ content: '❌ **هذا الزر مخصص لصاحب عرض السجل.**', flags: 64 });
        }
        const direction = match[1];
        const targetId = match[3];
        const currentPage = Number(match[4]);
        const page = direction === 'prev' ? currentPage - 1 : currentPage + 1;
        return sendHistory(null, context, targetId, interaction.user.id, page, interaction);
    },
    collectHistory
};
