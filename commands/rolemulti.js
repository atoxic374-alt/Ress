const {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    RoleSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    PermissionFlagsBits
} = require('discord.js');
const colorManager = require('../utils/colorManager');

const ACTIVE_SESSIONS = new Set();

const DANGEROUS_PERMISSIONS = [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.ManageWebhooks,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.MentionEveryone
];

function isDangerousRole(role) {
    if (!role) return true;
    if (role.managed) return true;
    return role.permissions.has(DANGEROUS_PERMISSIONS);
}

function makeProgressBar(done, total, size = 18) {
    const safeTotal = Math.max(1, total);
    const ratio = Math.max(0, Math.min(1, done / safeTotal));
    const fill = Math.round(size * ratio);
    return `[${'■'.repeat(fill)}${'□'.repeat(Math.max(0, size - fill))}]`;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitChunks(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

async function withRetry(task, maxRetries = 3) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
            return await task();
        } catch (error) {
            lastError = error;
            const status = Number(error?.status || error?.rawError?.status || 0);
            const retryAfter = Number(error?.data?.retry_after || error?.retry_after || 0);
            const retryable = status === 429 || status >= 500 || error?.code === 'ETIMEDOUT' || error?.code === 'ECONNRESET';
            if (!retryable || attempt === maxRetries) break;
            const waitMs = retryAfter > 0 ? Math.ceil(retryAfter * 1000) + 300 : 500 + attempt * 500;
            await sleep(waitMs);
        }
    }
    throw lastError;
}

function renderPanel(guild, state, ended = false) {
    const roleText = state.roleId ? `<@&${state.roleId}>` : '**غير محدد**';
    const actionText = state.mode === 'add' ? '**إضافة**' : state.mode === 'remove' ? '**إزالة**' : '**غير محدد**';
    const scopeText = state.scope === 'bots' ? '**البوتات فقط**' : state.scope === 'humans' ? '**الأعضاء فقط**' : state.scope === 'all' ? '**الكل**' : '**غير محدد**';
    const readyToFinish = Boolean(state.roleId && state.mode && state.scope);

    const embed = colorManager.createEmbed()
        .setAuthor({ name: guild.name, iconURL: guild.iconURL({ dynamic: true }) || undefined })
        .setTitle('**نظام rolemulti**')
        .setDescription([
            '**حدد الخيارات ثم اضغط إنهاء لبدء التنفيذ.**',
            '',
            `**الرول :** ${roleText}`,
            `**العملية :** ${actionText}`,
            `**النطاق :** ${scopeText}`,
            '',
            ended ? '**تم إنهاء الجلسة.**' : '**هذه القائمة خاصة بمنفذ الأمر فقط.**',
            ended ? '' : (readyToFinish ? '**يمكنك الآن الضغط على إنهاء.**' : '**لن يتفعل زر إنهاء حتى تحدد كل المنيوهات الثلاث.**')
        ].join('\n'))
        .setTimestamp();

    const roleMenu = new RoleSelectMenuBuilder()
        .setCustomId('rolemulti_role')
        .setPlaceholder('اختر الرول')
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(ended);

    if (state.roleId && typeof roleMenu.setDefaultRoles === 'function') {
        roleMenu.setDefaultRoles(state.roleId);
    }

    const actionMenu = new StringSelectMenuBuilder()
        .setCustomId('rolemulti_mode')
        .setPlaceholder('اختر العملية')
        .setDisabled(ended)
        .addOptions([
            { label: 'إضافة للكل', value: 'add', default: state.mode === 'add' },
            { label: 'إزالة من الكل', value: 'remove', default: state.mode === 'remove' }
        ]);

    const scopeMenu = new StringSelectMenuBuilder()
        .setCustomId('rolemulti_scope')
        .setPlaceholder('اختر النطاق')
        .setDisabled(ended)
        .addOptions([
            { label: 'البوتات فقط', value: 'bots', default: state.scope === 'bots' },
            { label: 'الأعضاء فقط', value: 'humans', default: state.scope === 'humans' },
            { label: 'الكل', value: 'all', default: state.scope === 'all' }
        ]);

    const finishButton = new ButtonBuilder()
        .setCustomId('rolemulti_finish')
        .setLabel('إنهاء')
        .setStyle(ButtonStyle.Success)
        .setDisabled(ended || !readyToFinish);

    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(roleMenu),
            new ActionRowBuilder().addComponents(actionMenu),
            new ActionRowBuilder().addComponents(scopeMenu),
            new ActionRowBuilder().addComponents(finishButton)
        ]
    };
}

async function executeBulk({ guild, role, mode, scope, statusMessage, actorTag }) {
    await guild.members.fetch();

    const everyone = guild.members.cache.filter((m) => !m.user.bot && !m.user.system);
    const bots = guild.members.cache.filter((m) => m.user.bot || m.user.system);

    const source = scope === 'bots' ? bots : scope === 'humans' ? everyone : guild.members.cache;
    const members = [...source.values()];

    const candidates = members.filter((member) => {
        const hasRole = member.roles.cache.has(role.id);
        return mode === 'add' ? !hasRole : hasRole;
    });

    const total = candidates.length;
    let done = 0;
    let success = 0;
    let failed = 0;
    const affected = [];

    const chunks = splitChunks(candidates, 8);
    const startedAt = Date.now();

    const updateProgress = async (force = false) => {
        if (!force && done % 12 !== 0 && done !== total) return;

        const progressEmbed = colorManager.createEmbed()
            .setAuthor({ name: guild.name, iconURL: guild.iconURL({ dynamic: true }) || undefined })
            .setTitle('**جاري تنفيذ rolemulti**')
            .setDescription([
                `**الرول :** <@&${role.id}>`,
                `**العملية :** ${mode === 'add' ? 'إضافة' : 'إزالة'}`,
                `**النطاق :** ${scope === 'bots' ? 'البوتات فقط' : scope === 'humans' ? 'الأعضاء فقط' : 'الكل'}`,
                '',
                `**التقدم :** ${makeProgressBar(done, total)} ${done} / ${total}`,
                `**نجاح :** ${success}`,
                `**فشل :** ${failed}`,
                `**متبقي :** ${Math.max(0, total - done)}`
            ].join('\n'))
            .setFooter({ text: `By ${actorTag}` })
            .setTimestamp();

        await statusMessage.edit({ embeds: [progressEmbed] }).catch(() => null);
    };

    await updateProgress(true);

    for (const chunk of chunks) {
        await Promise.all(chunk.map(async (member) => {
            try {
                await withRetry(async () => {
                    if (mode === 'add') {
                        await member.roles.add(role, 'rolemulti bulk add');
                    } else {
                        await member.roles.remove(role, 'rolemulti bulk remove');
                    }
                }, 3);
                success += 1;
                affected.push(member.id);
            } catch (error) {
                failed += 1;
            } finally {
                done += 1;
            }
        }));

        await updateProgress();
        await sleep(700);
    }

    const durationMs = Date.now() - startedAt;
    return { total, success, failed, affected, durationMs };
}

module.exports = {
    name: 'rolemulti',
    description: 'إضافة أو إزالة رول بشكل جماعي مع فلاتر متقدمة',
    aliases: ['rolemulti'],

    async execute(message, _args, { BOT_OWNERS = [] }) {
        if (!BOT_OWNERS.includes(message.author.id)) {
            return message.reply({
                content: '**هذا الأمر متاح فقط لـ Owner البوت.**',
                flags: MessageFlags.Ephemeral
            });
        }

        if (!message.guild) {
            return message.reply('**لا يمكن استخدام هذا الأمر خارج السيرفر.**');
        }

        if (!message.guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
            return message.reply('**البوت لا يملك صلاحية Manage Roles.**');
        }

        if (ACTIVE_SESSIONS.has(message.author.id)) {
            return message.reply('**لديك جلسة rolemulti نشطة بالفعل.**');
        }

        const state = {
            roleId: null,
            mode: null,
            scope: null
        };

        const panel = await message.reply(renderPanel(message.guild, state));
        ACTIVE_SESSIONS.add(message.author.id);

        const collector = panel.createMessageComponentCollector({
            time: 5 * 60 * 1000,
            filter: (i) => i.user.id === message.author.id
        });

        let completed = false;

        collector.on('collect', async (interaction) => {
            try {
                if (interaction.customId === 'rolemulti_role') {
                    state.roleId = interaction.values[0];
                    const selectedRole = interaction.guild.roles.cache.get(state.roleId);

                    if (!selectedRole) {
                        await interaction.reply({ content: '**الرول غير موجود.**', flags: MessageFlags.Ephemeral });
                        return;
                    }

                    if (selectedRole.position >= interaction.guild.members.me.roles.highest.position) {
                        await interaction.reply({ content: '**لا يمكن التعامل مع رول أعلى من رول البوت أو مساوي له.**', flags: MessageFlags.Ephemeral });
                        return;
                    }

                    if (isDangerousRole(selectedRole)) {
                        state.roleId = null;
                        await interaction.reply({ content: '**الرول المحدد مرفوض لأنه يحتوي صلاحيات خطيرة أو رول مدمج.**', flags: MessageFlags.Ephemeral });
                        await interaction.message.edit(renderPanel(interaction.guild, state));
                        return;
                    }

                    await interaction.update(renderPanel(interaction.guild, state));
                    return;
                }

                if (interaction.customId === 'rolemulti_mode') {
                    state.mode = interaction.values[0];
                    await interaction.update(renderPanel(interaction.guild, state));
                    return;
                }

                if (interaction.customId === 'rolemulti_scope') {
                    state.scope = interaction.values[0];
                    await interaction.update(renderPanel(interaction.guild, state));
                    return;
                }

                if (interaction.customId === 'rolemulti_finish') {
                    if (!state.roleId || !state.mode || !state.scope) {
                        await interaction.reply({ content: '**يجب تحديد الرول والعملية والنطاق قبل الضغط على إنهاء.**', flags: MessageFlags.Ephemeral });
                        return;
                    }

                    const role = interaction.guild.roles.cache.get(state.roleId);
                    if (!role) {
                        await interaction.reply({ content: '**الرول المحدد لم يعد موجوداً.**', flags: MessageFlags.Ephemeral });
                        return;
                    }

                    if (role.position >= interaction.guild.members.me.roles.highest.position) {
                        await interaction.reply({ content: '**لا يمكن التعامل مع رول أعلى من رول البوت أو مساوي له.**', flags: MessageFlags.Ephemeral });
                        return;
                    }

                    if (isDangerousRole(role)) {
                        await interaction.reply({ content: '**الرول المحدد مرفوض لأنه يحتوي صلاحيات خطيرة أو رول مدمج.**', flags: MessageFlags.Ephemeral });
                        return;
                    }

                    completed = true;
                    collector.stop('finished');

                    const processingEmbed = colorManager.createEmbed()
                        .setAuthor({ name: interaction.guild.name, iconURL: interaction.guild.iconURL({ dynamic: true }) || undefined })
                        .setTitle('**بدء تنفيذ rolemulti**')
                        .setDescription('**يتم الآن تجهيز الأعضاء وتنفيذ العملية.**')
                        .setTimestamp();

                    await interaction.update({ embeds: [processingEmbed], components: [] });

                    const result = await executeBulk({
                        guild: interaction.guild,
                        role,
                        mode: state.mode,
                        scope: state.scope,
                        statusMessage: panel,
                        actorTag: interaction.user.tag
                    });

                    const undoId = `rolemulti_undo_${Date.now()}_${interaction.user.id}`;
                    const undoButton = new ButtonBuilder()
                        .setCustomId(undoId)
                        .setLabel('Undo')
                        .setStyle(ButtonStyle.Secondary);

                    const summaryEmbed = colorManager.createEmbed()
                        .setAuthor({ name: interaction.guild.name, iconURL: interaction.guild.iconURL({ dynamic: true }) || undefined })
                        .setTitle('**تم إنهاء rolemulti**')
                        .setDescription([
                            `**الرول :** <@&${role.id}>`,
                            `**العملية :** ${state.mode === 'add' ? 'إضافة' : 'إزالة'}`,
                            `**النطاق :** ${state.scope === 'bots' ? 'البوتات فقط' : state.scope === 'humans' ? 'الأعضاء فقط' : 'الكل'}`,
                            '',
                            `**الإجمالي القابل للتنفيذ :** ${result.total}`,
                            `**نجاح :** ${result.success}`,
                            `**فشل :** ${result.failed}`,
                            `**المدة :** ${Math.ceil(result.durationMs / 1000)} ثانية`,
                            '',
                            '**زر Undo متاح لمدة دقيقة واحدة فقط.**'
                        ].join('\n'))
                        .setTimestamp();

                    await panel.edit({
                        embeds: [summaryEmbed],
                        components: result.affected.length > 0 ? [new ActionRowBuilder().addComponents(undoButton)] : []
                    });

                    if (result.affected.length > 0) {
                        const undoCollector = panel.createMessageComponentCollector({
                            time: 60 * 1000,
                            filter: (i) => i.user.id === message.author.id && i.customId === undoId
                        });

                        undoCollector.on('collect', async (undoInteraction) => {
                            await undoInteraction.deferUpdate();
                            const reverseMode = state.mode === 'add' ? 'remove' : 'add';
                            const members = await Promise.all(result.affected.map((id) => interaction.guild.members.fetch(id).catch(() => null)));
                            const validMembers = members.filter(Boolean);

                            let done = 0;
                            let success = 0;
                            let failed = 0;
                            const chunks = splitChunks(validMembers, 8);

                            for (const chunk of chunks) {
                                await Promise.all(chunk.map(async (member) => {
                                    try {
                                        await withRetry(async () => {
                                            if (reverseMode === 'add') await member.roles.add(role, 'rolemulti undo');
                                            else await member.roles.remove(role, 'rolemulti undo');
                                        }, 2);
                                        success += 1;
                                    } catch (e) {
                                        failed += 1;
                                    } finally {
                                        done += 1;
                                    }
                                }));
                                const undoProgress = colorManager.createEmbed()
                                    .setTitle('**جاري تنفيذ Undo**')
                                    .setDescription(`**التقدم :** ${makeProgressBar(done, validMembers.length)} ${done} / ${validMembers.length}`)
                                    .setTimestamp();
                                await panel.edit({ embeds: [undoProgress], components: [] }).catch(() => null);
                                await sleep(600);
                            }

                            const undoneEmbed = colorManager.createEmbed()
                                .setTitle('**تم تنفيذ Undo بنجاح**')
                                .setDescription([
                                    `**تم عكس العملية السابقة على الرول :** <@&${role.id}>`,
                                    `**نجاح :** ${success}`,
                                    `**فشل :** ${failed}`
                                ].join('\n'))
                                .setTimestamp();

                            await panel.edit({ embeds: [undoneEmbed], components: [] }).catch(() => null);
                            undoCollector.stop('used');
                        });

                        undoCollector.on('end', async (_, reason) => {
                            if (reason === 'used') return;
                            const finalComponents = panel.components?.length ? [] : null;
                            if (finalComponents === null) return;
                            const expiredEmbed = colorManager.createEmbed()
                                .setTitle('**انتهت مهلة Undo**')
                                .setDescription('**انتهت مدة التراجع ولم يعد الزر متاحاً.**')
                                .setTimestamp();
                            await panel.edit({ embeds: [expiredEmbed], components: [] }).catch(() => null);
                        });
                    }
                }
            } catch (error) {
                console.error('rolemulti interaction error:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: '**حدث خطأ أثناء معالجة التفاعل.**', flags: MessageFlags.Ephemeral }).catch(() => null);
                }
            }
        });

        collector.on('end', async (_, reason) => {
            ACTIVE_SESSIONS.delete(message.author.id);
            if (completed) return;

            const ended = renderPanel(message.guild, state, true);
            await panel.edit(ended).catch(() => null);
            if (reason === 'time') {
                await message.reply('**انتهت مهلة جلسة rolemulti.**').catch(() => null);
            }
        });
    }
};
