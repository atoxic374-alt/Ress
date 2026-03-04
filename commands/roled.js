const fs = require('fs');
const path = require('path');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { isUserBlocked } = require('./block.js');
const { isChannelBlocked } = require('./chatblock.js');
const { getGuildConfig, getGuildRoles } = require('../utils/customRolesSystem.js');

const name = 'roled';
const EXCLUSIONS_PATH = path.join(__dirname, '..', 'data', 'roledExclusions.json');
const SEARCH_OPTION_VALUE = 'roled_search_option';

function loadExclusions() {
    try {
        if (!fs.existsSync(EXCLUSIONS_PATH)) return {};
        const parsed = JSON.parse(fs.readFileSync(EXCLUSIONS_PATH, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        console.error('Failed to load roled exclusions:', error);
        return {};
    }
}

function saveExclusions(data) {
    try {
        fs.writeFileSync(EXCLUSIONS_PATH, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error('Failed to save roled exclusions:', error);
        return false;
    }
}

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

    const lines = pageItems.map((item) => [
        `**الرول:** ${item.role}`,
        `**Display Owner:** ${item.owner}`,
        `**الأعضاء:** ${item.count}`
    ].join('\n'));

    return colorManager.createEmbed()
        .setTitle('📋 الرولات الأقل من 5 أعضاء')
        .setDescription(
            `**المنفذ:** <@${requesterId}>\n` +
            `**الإجمالي:** \`${roles.length}\` رول\n\n` +
            (lines.length > 0 ? lines.join('\n\n') : '**لا توجد بيانات لعرضها في هذه الصفحة**')
        )
        .addFields({ name: 'الصفحة', value: `**${currentPage + 1} / ${totalPages}**`, inline: true })
        .setThumbnail(guild.iconURL({ dynamic: true }))
        .setTimestamp();
}

function buildExclusionMenuRow(allRoles, excludedRoleIds = [], searchQuery = '') {
    const normalizedQuery = (searchQuery || '').trim().toLowerCase();
    const filtered = allRoles.filter((entry) => {
        if (!normalizedQuery) return true;
        const roleName = (entry.role.name || '').toLowerCase();
        const roleId = entry.role.id;
        const ownerId = entry.ownerId || '';
        return roleName.includes(normalizedQuery) || roleId.includes(normalizedQuery) || ownerId.includes(normalizedQuery);
    });

    const needsSearchOption = !normalizedQuery && filtered.length > 25;
    const optionsSource = needsSearchOption ? filtered.slice(0, 24) : filtered.slice(0, 25);

    const visibleRoleIds = optionsSource.map((entry) => entry.role.id);
    const options = optionsSource.map((entry) => ({
        label: (entry.role.name && entry.role.name.trim() ? entry.role.name : `Role ${entry.role.id}`).slice(0, 100),
        description: (`Display Owner: ${entry.ownerText}`).slice(0, 100),
        value: entry.role.id,
        default: excludedRoleIds.includes(entry.role.id)
    }));

    if (needsSearchOption) {
        options.push({ label: '🔎 بحث', value: SEARCH_OPTION_VALUE, description: 'بحث عن رول بالاسم / ID / Owner ID' });
    }

    if (options.length === 0) {
        options.push({ label: 'لا توجد نتائج', value: 'roled_no_results', description: 'جرّب بحثًا آخر' });
    }

    const maxValues = options.some((opt) => opt.value === 'roled_no_results')
        ? 1
        : Math.min(25, options.length);

    const menu = new StringSelectMenuBuilder()
        .setCustomId('roled_exceptions_select')
        .setPlaceholder('استثناء - اختر الرولات المستثناة (الاختيار يحفظ مباشرة)')
        .setMinValues(0)
        .setMaxValues(maxValues)
        .addOptions(options);

    return {
        row: new ActionRowBuilder().addComponents(menu),
        visibleRoleIds,
        hasSearchOption: needsSearchOption
    };
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
    if (isChannelBlocked(message.channel.id)) return;

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
                ownerId: entry.ownerId || '',
                ownerText: entry.ownerId ? `${entry.ownerId}` : 'غير معروف',
                ownerMention: entry.ownerId ? `<@${entry.ownerId}>` : 'غير معروف'
            };
        })
        .filter(Boolean)
        .sort((a, b) => b.role.position - a.role.position);

    if (allRoles.length === 0) {
        await message.reply('**❌ لا توجد رولات خاصة مسجلة للفحص.**');
        return;
    }

    const allExclusions = loadExclusions();
    let excludedRoleIds = Array.isArray(allExclusions[message.guild.id]) ? allExclusions[message.guild.id] : [];

    const pageSize = 8;
    let page = 0;
    let totalPages = 1;
    let matchedRoles = [];
    let menuQuery = '';

    const recalculateMatchedRoles = () => {
        matchedRoles = allRoles
            .map((entry) => ({ role: entry.role, owner: entry.ownerMention, count: entry.role.members.size }))
            .filter((entry) => entry.count < 5 && !excludedRoleIds.includes(entry.role.id));

        totalPages = Math.max(1, Math.ceil(matchedRoles.length / pageSize));
        page = Math.min(page, totalPages - 1);
    };

    const buildComponents = () => {
        const menuData = buildExclusionMenuRow(allRoles, excludedRoleIds, menuQuery);
        return {
            rows: [...buildActionRows(page, totalPages), menuData.row],
            visibleRoleIds: menuData.visibleRoleIds
        };
    };

    let checked = 0;
    const loadingMessage = await message.channel.send({
        embeds: [buildLoadingEmbed(message.guild, message.author.id, checked, allRoles.length, matchedRoles.length)]
    });

    let lastProgressUpdateAt = 0;
    for (const entry of allRoles) {
        checked += 1;
        const memberCount = entry.role.members.size;
        if (memberCount < 5 && !excludedRoleIds.includes(entry.role.id)) {
            matchedRoles.push({ role: entry.role, owner: entry.ownerMention, count: memberCount });
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

    recalculateMatchedRoles();
    let currentComponents = buildComponents();
    await loadingMessage.edit({
        embeds: [buildResultsEmbed(message.guild, message.author.id, matchedRoles, page, pageSize)],
        components: currentComponents.rows
    });

    const collector = loadingMessage.createMessageComponentCollector({ time: 120000 });

    collector.on('collect', async (interaction) => {
        if (interaction.user.id !== message.author.id) {
            await interaction.reply({ content: '❌ فقط منفذ الأمر يمكنه استخدام العناصر.', ephemeral: true });
            return;
        }

        if (interaction.customId === 'roled_prev') {
            page = Math.max(0, page - 1);
            currentComponents = buildComponents();
            await interaction.update({
                embeds: [buildResultsEmbed(message.guild, message.author.id, matchedRoles, page, pageSize)],
                components: currentComponents.rows
            });
            return;
        }

        if (interaction.customId === 'roled_next') {
            page = Math.min(totalPages - 1, page + 1);
            currentComponents = buildComponents();
            await interaction.update({
                embeds: [buildResultsEmbed(message.guild, message.author.id, matchedRoles, page, pageSize)],
                components: currentComponents.rows
            });
            return;
        }

        if (interaction.customId === 'roled_exceptions_select') {
            const selectedValues = interaction.values || [];

            if (selectedValues.includes('roled_no_results')) {
                await interaction.deferUpdate();
                return;
            }

            if (selectedValues.includes(SEARCH_OPTION_VALUE)) {
                if (selectedValues.length > 1) {
                    await interaction.reply({ content: '⚠️ اختر خيار البحث وحده.', ephemeral: true });
                    return;
                }

                const modal = new ModalBuilder()
                    .setCustomId(`roled_search_modal_${interaction.user.id}`)
                    .setTitle('بحث عن رول');

                const queryInput = new TextInputBuilder()
                    .setCustomId('roled_search_query')
                    .setLabel('ابحث بالاسم أو ID أو Owner ID')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setPlaceholder('مثال: اسم الرول أو 123456...');

                modal.addComponents(new ActionRowBuilder().addComponents(queryInput));
                await interaction.showModal(modal);

                try {
                    const modalSubmit = await interaction.awaitModalSubmit({
                        filter: (m) => m.customId === `roled_search_modal_${interaction.user.id}` && m.user.id === interaction.user.id,
                        time: 45000
                    });

                    menuQuery = modalSubmit.fields.getTextInputValue('roled_search_query')?.trim() || '';
                    currentComponents = buildComponents();
                    await modalSubmit.update({
                        embeds: [buildResultsEmbed(message.guild, message.author.id, matchedRoles, page, pageSize)],
                        components: currentComponents.rows
                    });
                } catch (_) {
                    // ignore timeout
                }
                return;
            }

            const selectedRoleIds = selectedValues.filter((value) => value !== SEARCH_OPTION_VALUE);
            const excludedSet = new Set(excludedRoleIds);

            for (const roleId of currentComponents.visibleRoleIds) {
                excludedSet.delete(roleId);
            }
            for (const roleId of selectedRoleIds) {
                excludedSet.add(roleId);
            }

            excludedRoleIds = [...excludedSet];
            allExclusions[message.guild.id] = excludedRoleIds;
            saveExclusions(allExclusions);
            recalculateMatchedRoles();

            currentComponents = buildComponents();
            await interaction.update({
                embeds: [buildResultsEmbed(message.guild, message.author.id, matchedRoles, page, pageSize)],
                components: currentComponents.rows
            });
            await interaction.followUp({ content: '✅ تم حفظ الاستثناءات', ephemeral: true });
            return;
        }

        if (interaction.customId === 'roled_cancel') {
            collector.stop('cancelled');
            currentComponents = buildComponents();
            await interaction.update({
                embeds: [
                    colorManager.createEmbed()
                        .setTitle('🛑 تم إلغاء العملية')
                        .setDescription('**تم إيقاف أمر roled بدون حذف أي رول.**')
                        .setTimestamp()
                ],
                components: [...buildActionRows(page, totalPages, true), currentComponents.rows[2]]
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
                components: [...buildActionRows(page, totalPages, true), currentComponents.rows[2]]
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
                        .setDescription(`**نجاح:** \`${success}\`\n**فشل:** \`${failed}\``)
                        .setTimestamp()
                ],
                components: []
            });
        }
    });

    collector.on('end', async (_, reason) => {
        if (reason === 'cancelled' || reason === 'deleted') return;
        try {
            currentComponents = buildComponents();
            await loadingMessage.edit({
                components: [...buildActionRows(page, totalPages, true), currentComponents.rows[2]]
            });
        } catch (error) {
            console.error('roled collector end edit error:', error);
        }
    });
}

module.exports = { name, execute };
