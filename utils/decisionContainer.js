const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SectionBuilder,
    ThumbnailBuilder,
    MessageFlags
} = require('discord.js');
const colorManager = require('./colorManager.js');

function formatRiyadhTime(date = new Date()) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Riyadh',
        dateStyle: 'medium',
        timeStyle: 'short'
    }).format(date);
}

function safeAvatar(member, guild) {
    return member?.user?.displayAvatarURL({ extension: 'png', size: 128 })
        || guild?.iconURL({ extension: 'png', size: 128 })
        || 'https://cdn.discordapp.com/embed/avatars/0.png';
}

function createDecisionContainer({
    approved,
    title = null,
    targetMember = null,
    targetUserId,
    actorId,
    guild,
    details = [],
    footer = 'R Sys'
}) {
    const heading = title || (approved ? '✅ Accepted' : '❌ Rejected');
    const accentColor = colorManager.getColor() || '#5865F2';
    const lines = [
        `**Status :** ${approved ? 'موافق' : 'مرفوض'}`,
        '',
        targetUserId ? `**Applicant :** <@${targetUserId}>` : null,
        targetUserId ? '' : null,
        `**${approved ? 'Approved by' : 'Rejected by'} :** <@${actorId}>`,
        '',
        ...details.flatMap(detail => [detail, '']).filter(value => value !== null && value !== undefined),
        `**الوقت :** ${formatRiyadhTime()}`
    ].filter(value => value !== null && value !== undefined).join('\n');

    const section = new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${heading}`))
        .setThumbnailAccessory(new ThumbnailBuilder()
            .setURL(safeAvatar(targetMember, guild))
            .setDescription(`صورة ${targetMember?.displayName || 'المستخدم'}`));

    return new ContainerBuilder()
        .setAccentColor(accentColor)
        .addSectionComponents(section)
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.slice(0, 3500)))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footer} • ${guild?.name || 'Server'}`));
}

function decisionPayload(container) {
    return {
        components: [container],
        flags: MessageFlags.IsComponentsV2
    };
}

module.exports = { formatRiyadhTime, createDecisionContainer, decisionPayload };
