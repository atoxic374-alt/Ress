const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { isUserBlocked } = require('./block.js');
const { isChannelBlocked } = require('./chatblock.js');
const { getGuildConfig, getGuildRoles } = require('../utils/customRolesSystem.js');

const name = 'roled';

function canManageSpecialRoles(member, guildConfig, botOwners = []) {
    if (!member || !guildConfig) return false;
    if (botOwners.includes(member.id)) return true;
    if ((guildConfig.managerUserIds || []).includes(member.id)) return true;

    const managerRoleIds = Array.isArray(guildConfig.managerRoleIds) ? guildConfig.managerRoleIds : [];
    if (managerRoleIds.length === 0) return false;
    return member.roles.cache.some((role) => managerRoleIds.includes(role.id));
}

function buildLoadingEmbed(guild, requesterId, checked, total, matched) {
    return colorManager.createEmbed()
        .setTitle('⏳ جاري فحص الرولات')
        .setDescription(
            `**المنفذ:** <@${requesterId}>\n` +
            `**السيرفر:** ${guild.name}\n` +
            `**Progress:** \`${checked}/${total}\`\n` +
            `**الرولات الأقل من 5 أعضاء:** \`${matched}\``
        )
        .setThumbnail(guild.iconURL({ dynamic: true }))
        .setTimestamp();
}

function buildResultsEmbed(guild, requesterId, roles, page, pageSize) {
    const totalPages = Math.max(1, Math.ceil(roles.length / pageSize));
    const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
    const start = currentPage * pageSize;
    const pageItems = roles.slice(start, start + pageSize);

    const lines = pageItems.map((item) => `**${item.role.toString()}  owner : ${item.owner}  number : ${item.count}**`);

    return colorManager.createEmbed()
        .setTitle('📋 الرولات الأقل من 5 أعضاء')
        .setDescription(
            `**المنفذ:** <@${requesterId}>\n` +
            `**الإجمالي:** \`${roles.length}\` رول\n\n` +
            (lines.length > 0 ? lines.join('\n') : '**لا توجد بيانات لعرضها في هذه الصفحة**')
        )
        .addFields({ name: 'الصفحة', value: `**${currentPage + 1} / ${totalPages}**`, inline: true })
        .setThumbnail(guild.iconURL({ dynamic: true }))
        .setTimestamp();
}

function buildActionRows(page, totalPages, disabled = false) {
    const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('roled_prev')
            .setLabel('◀️ السابق')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || page <= 0),
        new ButtonBuilder()
            .setCustomId('roled_next')
            .setLabel('التالي ▶️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || page >= totalPages - 1)
    );

    const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('roled_delete')
            .setLabel('🗑️ حذف')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId('roled_cancel')
            .setLabel('✖️ إلغاء')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled)
    );

    return [navRow, actionRow];
}

async function execute(message, args, { client, BOT_OWNERS }) {
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

    const guildConfig = getGuildConfig(message.guild.id);
    const hasPermission = canManageSpecialRoles(message.member, guildConfig, BOT_OWNERS || []);

    if (!hasPermission) {
        await message.reply('**❌ هذا الأمر متاح فقط لأونر البوت أو مسؤول الرولات الخاصة.**');
        return;
    }

    const specialRolesEntries = getGuildRoles(message.guild.id);
    const allRoles = specialRolesEntries
        .map((entry) => {
            const role = message.guild.roles.cache.get(entry.roleId);
            if (!role) return null;
            return {
                role,
                owner: entry.ownerId ? `<@${entry.ownerId}>` : 'غير معروف'
            };
        })
        .filter(Boolean)
        .sort((a, b) => b.role.position - a.role.position);

    if (allRoles.length === 0) {
        await message.reply('**❌ لا توجد رولات خاصة مسجلة للفحص.**');
        return;
    }

    let checked = 0;
    const matchedRoles = [];

    const loadingMessage = await message.channel.send({
        embeds: [buildLoadingEmbed(message.guild, message.author.id, checked, allRoles.length, matchedRoles.length)]
    });

    let lastProgressUpdateAt = 0;
    for (const entry of allRoles) {
        checked += 1;
        const role = entry.role;
        const memberCount = role.members.size;

        if (memberCount < 5) {
            matchedRoles.push({
                role,
                owner: entry.owner,
                count: memberCount
            });
        }

        const now = Date.now();
        const shouldUpdate = checked === allRoles.length || checked % 10 === 0 || (now - lastProgressUpdateAt) > 2000;
        if (shouldUpdate) {
            lastProgressUpdateAt = now;
            await loadingMessage.edit({
                embeds: [buildLoadingEmbed(message.guild, message.author.id, checked, allRoles.length, matchedRoles.length)]
            }).catch(() => {});
        }
    }

    if (matchedRoles.length === 0) {
        await loadingMessage.edit({
            embeds: [
                colorManager.createEmbed()
                    .setTitle('✅ اكتمل الفحص')
                    .setDescription('**لا توجد أي رولات أقل من 5 أعضاء.**')
                    .setThumbnail(message.guild.iconURL({ dynamic: true }))
                    .setTimestamp()
            ],
            components: []
        });
        return;
    }

    const pageSize = 8;
    let page = 0;
    const totalPages = Math.max(1, Math.ceil(matchedRoles.length / pageSize));

    await loadingMessage.edit({
        embeds: [buildResultsEmbed(message.guild, message.author.id, matchedRoles, page, pageSize)],
        components: buildActionRows(page, totalPages)
    });

    const collector = loadingMessage.createMessageComponentCollector({ time: 120000 });

    collector.on('collect', async (interaction) => {
        if (interaction.user.id !== message.author.id) {
            await interaction.reply({ content: '❌ فقط منفذ الأمر يمكنه استخدام الأزرار.', ephemeral: true });
            return;
        }

        if (interaction.customId === 'roled_prev') {
            page = Math.max(0, page - 1);
            await interaction.update({
                embeds: [buildResultsEmbed(message.guild, message.author.id, matchedRoles, page, pageSize)],
                components: buildActionRows(page, totalPages)
            });
            return;
        }

        if (interaction.customId === 'roled_next') {
            page = Math.min(totalPages - 1, page + 1);
            await interaction.update({
                embeds: [buildResultsEmbed(message.guild, message.author.id, matchedRoles, page, pageSize)],
                components: buildActionRows(page, totalPages)
            });
            return;
        }

        if (interaction.customId === 'roled_cancel') {
            collector.stop('cancelled');
            await interaction.update({
                embeds: [
                    colorManager.createEmbed()
                        .setTitle('🛑 تم إلغاء العملية')
                        .setDescription('**تم إيقاف أمر roled بدون حذف أي رول.**')
                        .setTimestamp()
                ],
                components: buildActionRows(page, totalPages, true)
            });
            return;
        }

        if (interaction.customId === 'roled_delete') {
            await interaction.update({
                embeds: [
                    colorManager.createEmbed()
                        .setTitle('⏳ جاري حذف الرولات')
                        .setDescription(`**عدد الرولات المستهدفة:** \`${matchedRoles.length}\``)
                        .setTimestamp()
                ],
                components: buildActionRows(page, totalPages, true)
            });

            let success = 0;
            let failed = 0;

            for (const entry of matchedRoles) {
                try {
                    await entry.role.delete(`roled command by ${message.author.tag}`);
                    success += 1;
                } catch (error) {
                    console.error(`Failed to delete role ${entry.role?.id || 'unknown'} in roled command:`, error);
                    failed += 1;
                }
            }

            collector.stop('deleted');

            await loadingMessage.edit({
                embeds: [
                    colorManager.createEmbed()
                        .setTitle('✅ انتهت عملية الحذف')
                        .setDescription(
                            `**نجاح:** \`${success}\`\n` +
                            `**فشل:** \`${failed}\``
                        )
                        .setTimestamp()
                ],
                components: []
            });
        }
    });

    collector.on('end', async (_, reason) => {
        if (reason === 'cancelled' || reason === 'deleted') {
            return;
        }

        try {
            await loadingMessage.edit({
                components: buildActionRows(page, totalPages, true)
            });
        } catch (error) {
            console.error('roled collector end edit error:', error);
        }
    });
}

module.exports = { name, execute };
