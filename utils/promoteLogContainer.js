const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SectionBuilder,
    ThumbnailBuilder,
    MessageFlags
} = require('discord.js');

function formatRiyadhTime(date = new Date()) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Riyadh',
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    }).format(date);
}

function mentionUser(userOrId) {
    const id = typeof userOrId === 'object' ? userOrId?.id : userOrId;
    return id ? `<@${id}>` : 'Unknown';
}

function mentionRole(roleOrId) {
    const id = typeof roleOrId === 'object' ? roleOrId?.id : roleOrId;
    return id ? `<@&${id}>` : 'Unknown';
}

function clean(value, fallback = 'Not specified') {
    if (value === null || value === undefined || value === '') return fallback;
    return String(value);
}

function buildDetails(type, data) {
    const fields = [];
    const add = (label, value, inline = false) => {
        fields.push(`**${label} :** ${clean(value)}` + (inline ? '' : '\n'));
    };

    if (type === 'PROMOTION_APPLIED') {
        add('Member', mentionUser(data.targetUser));
        add('New Role', mentionRole(data.role));
        add('Previous Role', data.previousRole?.mention || mentionRole(data.previousRole));
        add('Duration', data.duration || 'Permanent');
        add('Reason', data.reason);
        add('Promoted by', mentionUser(data.byUser));
        if (data.removedOldRoles?.length) add('Removed Roles', data.removedOldRoles.join(', '));
        if (data.userStats) {
            fields.push('**Activity Statistics :**');
            add('Voice Time', `${Math.round((data.userStats.totalVoiceTime || 0) / 3600000)} hours`, true);
            add('Messages', data.userStats.totalMessages, true);
            add('Reactions', data.userStats.totalReactions, true);
            add('Active Days', data.userStats.activeDays, true);
        }
    } else if (type === 'MULTI_PROMOTION_APPLIED') {
        add('Member', mentionUser(data.targetUser));
        add('Roles Added', data.roles?.map(mentionRole).join(', ') || data.successCount);
        add('Successful Roles', data.successCount);
        add('Failed Roles', data.failedCount || 0);
        add('Duration', data.duration || 'Permanent');
        add('Reason', data.reason);
        add('Promoted by', mentionUser(data.byUser));
        if (data.removedOldRoles?.length) add('Removed Roles', data.removedOldRoles.join(', '));
    } else if (type === 'BULK_PROMOTION') {
        add('Source Role', data.sourceRoleId ? mentionRole(data.sourceRoleId) : data.sourceRoleName);
        add('Target Role', data.targetRoleId ? mentionRole(data.targetRoleId) : data.targetRoleName);
        add('Promoted by', mentionUser(data.moderatorId));
        add('Duration', data.duration || 'Permanent');
        add('Reason', data.reason);
        fields.push('**Results :**');
        add('Successful', data.successCount, true);
        add('Failed', data.failedCount, true);
        add('Banned', data.bannedCount, true);
        add('Excluded', data.excludedCount, true);
        add('Total Members', data.totalMembers, true);
        if (data.successfulMembers?.length) add('Successful Members', data.successfulMembers.slice(0, 20).map(mentionUser).join(' '));
    } else if (type === 'PROMOTION_ENDED') {
        add('Member', mentionUser(data.targetUser));
        add('Role Removed', mentionRole(data.role));
        add('Original Duration', data.duration);
        add('Original Reason', data.originalReason);
        add('End Reason', data.reason);
        add('Original Promoter', mentionUser(data.byUser));
    } else if (type === 'PROMOTION_MODIFIED') {
        add('Member', mentionUser(data.targetUser));
        add('Role', mentionRole(data.role));
        add('Previous Duration', data.oldDuration);
        add('New Duration', data.newDuration);
        add('Modified by', mentionUser(data.modifiedBy));
    } else if (type === 'PROMOTION_BAN_ADDED' || type === 'PROMOTION_BAN_REMOVED') {
        add('Member', mentionUser(data.targetUser));
        if (type === 'PROMOTION_BAN_ADDED') add('Ban Duration', data.duration || 'Permanent');
        add('Reason', data.reason);
        add(type === 'PROMOTION_BAN_ADDED' ? 'Banned by' : 'Unbanned by', mentionUser(data.byUser));
    }

    return fields.join('\n').replace(/\n{3,}/g, '\n\n').slice(0, 3500);
}

function createPromoteLogContainer(type, data, guild, client) {
    const titles = {
        PROMOTION_APPLIED: 'Promotion Applied',
        MULTI_PROMOTION_APPLIED: 'Multiple Promotion Applied',
        BULK_PROMOTION: 'Bulk Promotion Applied',
        PROMOTION_ENDED: 'Promotion Ended',
        PROMOTION_MODIFIED: 'Promotion Modified',
        PROMOTION_BAN_ADDED: 'Promotion Ban Added',
        PROMOTION_BAN_REMOVED: 'Promotion Ban Removed'
    };
    const status = type.includes('ENDED') || type.includes('BAN_REMOVED') ? 'Completed' : 'Completed successfully';
    const avatar = data.targetUser?.displayAvatarURL?.({ extension: 'png', size: 128 })
        || guild?.iconURL?.({ extension: 'png', size: 128 })
        || 'https://cdn.discordapp.com/embed/avatars/0.png';

    const section = new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${titles[type] || 'Promotion Log'}`))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatar).setDescription('Promotion log'));

    const body = [
        `**Status :** ${status}`,
        buildDetails(type, data),
        `**Time (Asia/Riyadh) :** ${formatRiyadhTime()}`
    ].filter(Boolean).join('\n\n');

    return new ContainerBuilder()
        .setAccentColor(type.includes('ENDED') || type.includes('BAN_REMOVED') ? 0xed4245 : 0x2596be)
        .addSectionComponents(section)
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(body.slice(0, 3900)))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${guild?.name || 'Server'} • Promote System`));
}

function promoteLogPayload(type, data, guild, client) {
    return {
        components: [createPromoteLogContainer(type, data, guild, client)],
        flags: MessageFlags.IsComponentsV2
    };
}

module.exports = { createPromoteLogContainer, promoteLogPayload, formatRiyadhTime };
