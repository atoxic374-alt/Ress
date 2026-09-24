const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const colorManager = require('../utils/colorManager');
const downManager = require('../utils/downManager');

const name = 'داونات';

async function buildRecords(guild) {
    const logs = downManager.getGuildDownHistory(guild.id);
    const activeDowns = Object.values(downManager.getActiveDowns());
    const records = [];
    for (const log of logs) {
        const data = log.data || {};
        const member = await guild.members.fetch(data.targetUserId).catch(() => null);
        const verbal = log.type === 'DOWN_VERBAL' || data.roleId === null || data.duration === 'شفوي' || data.duration === 'verbal';
        const isActive = !verbal && log.type === 'DOWN_APPLIED' && activeDowns.some(down =>
            down?.guildId === guild.id && down.userId === data.targetUserId && down.roleId === data.roleId &&
            Math.abs((down.startTime || down.timestamp || 0) - (log.timestamp || data.timestamp || 0)) <= 10 * 60 * 1000
        );
        const role = !verbal && data.roleId ? await guild.roles.fetch(data.roleId).catch(() => null) : null;
        records.push({
            targetId: data.targetUserId,
            targetName: member?.displayName || 'عضو غير موجود',
            roleName: verbal ? 'تنبيه شفوي' : (role ? role.name : `رول محذوف (${data.roleId || 'غير معروف'})`),
            action: log.type === 'DOWN_ENDED' ? 'تم إنهاء الداون' : (verbal ? 'تم تسجيل تنبيه شفوي' : 'تم سحب الرول'),
            status: isActive ? 'نشط حاليًا' : 'غير نشط',
            duration: verbal ? 'شفوي' : (data.duration || 'نهائي'),
            reason: data.reason || data.originalReason || 'غير محدد',
            moderatorId: data.byUserId || data.modifiedBy,
            timestamp: log.timestamp || data.timestamp || Date.now()
        });
    }
    return records;
}

function buildEmbed(record, page, totalPages) {
    const timestamp = Math.floor(record.timestamp / 1000);
    return colorManager.createEmbed()
        .setTitle('سجل الداونات العام')
        .setDescription(`السجل **${page + 1} من ${totalPages}**\n**العضو:** <@${record.targetId}> — ${record.targetName}`)
        .addFields(
            { name: 'الحالة', value: record.status, inline: true },
            { name: 'الإجراء', value: record.action, inline: true },
            { name: 'الرول', value: record.roleName, inline: true },
            { name: 'المدة', value: record.duration, inline: true },
            { name: 'السبب', value: String(record.reason).slice(0, 1000), inline: false },
            { name: 'بواسطة', value: record.moderatorId ? `<@${record.moderatorId}>` : 'غير معروف', inline: true },
            { name: 'التاريخ', value: `<t:${timestamp}:F> (<t:${timestamp}:R>)`, inline: true }
        )
        .setFooter({ text: `إجمالي السجلات: ${totalPages}` })
        .setTimestamp();
}

function components(viewerId, page, totalPages) {
    if (totalPages <= 1) return [];
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`down_all_history_prev_${viewerId}_${page}`).setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(`down_all_history_next_${viewerId}_${page}`).setLabel('التالي').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
    )];
}

async function render(message, context, viewerId, page = 0, interaction = null) {
    const guild = message?.guild || interaction?.guild;
    const records = await buildRecords(guild);
    if (!records.length) {
        const payload = { content: '❌ **لا توجد سجلات داون في هذا السيرفر.**', components: [] };
        return interaction ? interaction.update(payload) : message.reply(payload);
    }
    const safePage = Math.max(0, Math.min(page, records.length - 1));
    const payload = {
        embeds: [buildEmbed(records[safePage], safePage, records.length)],
        components: components(viewerId, safePage, records.length),
        allowedMentions: { parse: ['users'], roles: [] }
    };
    return interaction ? interaction.update(payload) : message.reply(payload);
}

module.exports = {
    name,
    description: 'عرض جميع سجلات الداون، سجل واحد في كل صفحة',
    async execute(message, args, context) {
        const owners = (context.BOT_OWNERS || []).map(String);
        const allowed = await downManager.hasPermission({ user: message.author, member: message.member, guild: message.guild }, owners);
        if (!allowed) return message.reply('❌ **هذا الأمر مخصص لمسؤولي الداون.**');
        return render(message, context, message.author.id);
    },
    async handleInteraction(interaction, context) {
        const match = interaction.customId.match(/^down_all_history_(prev|next)_(\d{16,20})_(\d+)$/);
        if (!match || interaction.user.id !== match[2]) {
            return interaction.reply({ content: '❌ **هذا الزر مخصص لمن فتح سجل الداونات.**', flags: 64 });
        }
        const page = match[1] === 'prev' ? Number(match[3]) - 1 : Number(match[3]) + 1;
        return render(null, context, interaction.user.id, page, interaction);
    }
};
