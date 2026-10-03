const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const colorManager = require('../utils/colorManager');
const downManager = require('../utils/downManager');

const name = 'داونات';
const PAGE_SIZE = 5;
const FILTERS = {
    all: { label: 'All Downs', description: 'عرض الداونات النشطة والمنتهية' },
    active: { label: 'Active Downs', description: 'عرض الداونات التي ما زالت مستمرة' },
    ended: { label: 'Ended Downs', description: 'عرض الداونات التي انتهت أو تم إنهاؤها' },
    verbal: { label: 'Verbal Downs', description: 'عرض الداونات الشفوية فقط' },
    week: { label: 'Last Week', description: 'عرض الداونات المسجلة خلال آخر 7 أيام' },
    today: { label: 'Today', description: 'عرض الداونات المسجلة اليوم' }
};

function resolveTargetId(message, args = []) {
    const mentionedUser = message?.mentions?.users?.first?.();
    if (mentionedUser?.id) return String(mentionedUser.id);
    const raw = String(args?.[0] || '').trim();
    return raw.replace(/[<@!>]/g, '').match(/^\d{15,21}$/)?.[0] || null;
}

function startOfToday() {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

async function buildRecords(guild, targetUserId = null) {
    const logs = downManager.getGuildDownHistory(guild.id);
    const activeDowns = Object.values(downManager.getActiveDowns());
    const records = [];

    for (const log of logs) {
        if (!['DOWN_APPLIED', 'DOWN_VERBAL'].includes(log.type)) continue;
        const data = log.data || {};
        const targetId = String(data.targetUserId || '');
        if (!targetId || (targetUserId && targetId !== String(targetUserId))) continue;

        const member = await guild.members.fetch(targetId).catch(() => null);
        const verbal = log.type === 'DOWN_VERBAL' || data.roleId === null || data.duration === 'شفوي' || data.duration === 'verbal';
        const active = !verbal && activeDowns.some(down =>
            down?.guildId === guild.id && String(down.userId) === targetId &&
            String(down.roleId) === String(data.roleId) && down.status === 'active' &&
            (!down.endTime || down.endTime > Date.now())
        );
        const role = !verbal && data.roleId ? await guild.roles.fetch(data.roleId).catch(() => null) : null;
        const timestamp = log.timestamp || data.timestamp || Date.now();
        const activeRecord = active;
        const activeDown = activeDowns.find(down =>
            activeRecord && down?.guildId === guild.id && String(down.userId) === targetId &&
            String(down.roleId) === String(data.roleId) && down.status === 'active'
        );

        records.push({
            targetId,
            targetName: member?.displayName || 'عضو غير موجود',
            roleName: verbal ? 'تنبيه شفوي' : (role?.name || `رول محذوف (${data.roleId || 'غير معروف'})`),
            roleId: data.roleId || null,
            active: activeRecord,
            status: verbal ? 'شفوي' : (activeRecord ? 'نشط' : 'منتهي'),
            duration: verbal ? 'شفوي' : (data.duration || 'نهائي'),
            endTime: activeDown?.endTime || null,
            reason: data.reason || data.originalReason || 'غير محدد',
            moderatorId: data.byUserId || data.modifiedBy,
            timestamp
        });
    }
    return records.sort((a, b) => b.timestamp - a.timestamp);
}

function filterRecords(records, filter) {
    const selected = FILTERS[filter] ? filter : 'all';
    if (selected === 'active') return records.filter(record => record.active);
    if (selected === 'ended') return records.filter(record => !record.active && record.status !== 'شفوي');
    if (selected === 'verbal') return records.filter(record => record.status === 'شفوي');
    if (selected === 'week') return records.filter(record => record.timestamp >= Date.now() - (7 * 24 * 60 * 60 * 1000));
    if (selected === 'today') return records.filter(record => record.timestamp >= startOfToday());
    return records;
}

function mentionOrName(record) {
    return `<@${record.targetId}> — **${record.targetName}**`;
}

function activeDetails(record) {
    const end = record.endTime ? `<t:${Math.floor(record.endTime / 1000)}:R> (ينتهي <t:${Math.floor(record.endTime / 1000)}:f>)` : '**نهائي ♾️**';
    return [
        `**الرول :** ${record.roleName}`,
        `**المسؤول :** ${record.moderatorId ? `<@${record.moderatorId}>` : 'غير معروف'}`,
        `**بدأ :** <t:${Math.floor(record.timestamp / 1000)}:f> (<t:${Math.floor(record.timestamp / 1000)}:R>)`,
        `**المتبقي :** ${end}`,
        `**السبب :** ${String(record.reason).replace(/\s+/g, ' ').slice(0, 180)}`
    ].join('\n');
}

function endedDetails(record) {
    const timestamp = Math.floor(record.timestamp / 1000);
    return [
        `**الرول :** ${record.roleName}`,
        `**المسؤول :** ${record.moderatorId ? `<@${record.moderatorId}>` : 'غير معروف'}`,
        `**المدة :** ${record.duration}`,
        `**التاريخ :** <t:${timestamp}:f> (<t:${timestamp}:R>)`,
        `**الحالة :** ${record.status === 'شفوي' ? 'تنبيه شفوي' : 'منتهي'}`,
        `**السبب :** ${String(record.reason).replace(/\s+/g, ' ').slice(0, 160)}`
    ].join('\n');
}

function buildEmbed(records, page, totalPages, filter, targetUserId = null) {
    const start = page * PAGE_SIZE;
    const pageRecords = records.slice(start, start + PAGE_SIZE);
    const description = pageRecords.map((record, index) => {
        const details = record.active ? activeDetails(record) : endedDetails(record);
        return `**${start + index + 1}.** ${mentionOrName(record)}\n${details}`;
    }).join('\n\n');

    return colorManager.createEmbed()
        .setTitle(`Down History • ${FILTERS[filter].label}`)
        .setDescription(`${targetUserId ? `العضو: <@${targetUserId}>\n` : ''}**${records.length}** سجل مطابق\n\n${description}`)
        .setFooter({ text: `الصفحة ${page + 1} من ${totalPages} • ${FILTERS[filter].description}` })
        .setTimestamp();
}

function components(viewerId, page, totalPages, filter, targetUserId = 'all') {
    const filterMenu = new StringSelectMenuBuilder()
        .setCustomId(`down_all_history_filter_${viewerId}_${targetUserId}`)
        .setPlaceholder('اختر فلتر عرض الداونات...')
        .addOptions(Object.entries(FILTERS).map(([value, item]) => ({
            label: item.label,
            value,
            description: item.description,
            default: value === filter
        })));
    const rows = [new ActionRowBuilder().addComponents(filterMenu)];
    if (totalPages > 1) {
        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`down_all_history_prev_${viewerId}_${page}_${filter}_${targetUserId}`).setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId(`down_all_history_next_${viewerId}_${page}_${filter}_${targetUserId}`).setLabel('التالي').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
        ));
    }
    return rows;
}

async function render(message, context, viewerId, page = 0, interaction = null, filter = 'all', targetUserId = null) {
    const guild = message?.guild || interaction?.guild;
    if (!guild) return;
    const allRecords = await buildRecords(guild, targetUserId);
    const records = filterRecords(allRecords, filter);
    const selectedFilter = FILTERS[filter] ? filter : 'all';
    if (!records.length) {
        const targetText = targetUserId ? ` للعضو <@${targetUserId}>` : '';
        const payload = {
            content: `❌ **لا توجد داونات مطابقة لفلتر «${FILTERS[selectedFilter].label}»${targetText}.**`,
            embeds: [],
            components: components(viewerId, 0, 1, selectedFilter, targetUserId || 'all')
        };
        if (interaction) return interaction.deferred || interaction.replied ? interaction.editReply(payload) : interaction.update(payload);
        return message.reply(payload);
    }

    const totalPages = Math.ceil(records.length / PAGE_SIZE);
    const safePage = Math.max(0, Math.min(Number(page) || 0, totalPages - 1));
    const payload = {
        embeds: [buildEmbed(records, safePage, totalPages, selectedFilter, targetUserId)],
        components: components(viewerId, safePage, totalPages, selectedFilter, targetUserId || 'all'),
        allowedMentions: { parse: ['users'], roles: [] }
    };
    if (interaction) return interaction.deferred || interaction.replied ? interaction.editReply(payload) : interaction.update(payload);
    return message.reply(payload);
}

module.exports = {
    name,
    description: 'لوحة فلاتر سجل الداونات: الكل، النشطة، المنتهية، الأسبوع، واليوم',
    async execute(message, args, context) {
        const owners = (context.BOT_OWNERS || []).map(String);
        const allowed = await downManager.hasPermission({ user: message.author, member: message.member, guild: message.guild }, owners);
        if (!allowed) return message.reply('❌ **هذا الأمر مخصص لمسؤولي الداون.**');
        return render(message, context, message.author.id, 0, null, 'all', resolveTargetId(message, args));
    },
    async handleInteraction(interaction, context) {
        const id = interaction.customId;
        const filterMatch = id.match(/^down_all_history_filter_(\d{15,21})_(\d{15,21}|all)$/);
        if (filterMatch) {
            if (interaction.user.id !== filterMatch[1]) return interaction.reply({ content: '❌ **هذه القائمة مخصصة لمن فتح سجل الداونات.**', flags: 64 });
            await interaction.deferUpdate().catch(() => {});
            const filter = FILTERS[interaction.values?.[0]] ? interaction.values[0] : 'all';
            const targetUserId = filterMatch[2] !== 'all' ? filterMatch[2] : null;
            return render(null, context, interaction.user.id, 0, interaction, filter, targetUserId);
        }

        const match = id.match(/^down_all_history_(prev|next)_(\d{15,21})_(\d+)(?:_(all|active|ended|verbal|week|today))?(?:_(\d{15,21}|all))?$/);
        if (!match) return false;
        if (interaction.user.id !== match[2]) return interaction.reply({ content: '❌ **هذا الزر مخصص لمن فتح سجل الداونات.**', flags: 64 });
        await interaction.deferUpdate().catch(() => {});
        const currentPage = Number(match[3]);
        const page = match[1] === 'prev' ? currentPage - 1 : currentPage + 1;
        const filter = FILTERS[match[4]] ? match[4] : 'all';
        const targetUserId = match[5] && match[5] !== 'all' ? match[5] : null;
        return render(null, context, interaction.user.id, page, interaction, filter, targetUserId);
    }
};
