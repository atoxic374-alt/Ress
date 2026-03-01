const { 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    StringSelectMenuBuilder 
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const colorManager = require('../utils/colorManager.js');
const vacationManager = require('../utils/vacationManager.js');

// مسارات الملفات
const dataDir = path.join(__dirname, '..', 'data');
const vacationsPath = path.join(dataDir, 'vacations.json');

// التأكد من وجود المجلد والملفات الأساسية
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(vacationsPath)) {
    fs.writeFileSync(vacationsPath, JSON.stringify({ active: {}, pending: {}, rejected: {}, cooldowns: {} }, null, 2));
}

/**
 * قراءة ملف JSON بأمان مع معالجة الأخطاء البرمجية
 */
function readJson(filePath, defaultData = {}) {
    try {
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            if (!content.trim()) return defaultData;
            return JSON.parse(content);
        }
    } catch (error) {
        console.error(`[Vacations] Error reading ${filePath}:`, error);
    }
    return defaultData;
}

/**
 * حفظ ملف JSON بأمان مع عمل نسخة احتياطية بسيطة عند الفشل
 */
function writeJson(filePath, data) {
    try {
        const content = JSON.stringify(data, null, 2);
        fs.writeFileSync(filePath, content);
        return true;
    } catch (error) {
        console.error(`[Vacations] Critical Error writing ${filePath}:`, error);
        return false;
    }
}

/**
 * التحقق من الصلاحيات (أونر فقط)
 */
function isBotOwner(userId, BOT_OWNERS) {
    return Array.isArray(BOT_OWNERS) && BOT_OWNERS.includes(userId);
}

async function execute(message, args, { BOT_OWNERS }) {
    const member = message.member;
    const isOwner = isBotOwner(message.author.id, BOT_OWNERS);
    
    // التحقق من الصلاحيات (أونر أو معتمد)
    const settings = vacationManager.getSettings();
    const isAuthorized = isOwner || await vacationManager.isUserAuthorizedApprover(
        message.author.id,
        message.guild,
        settings,
        BOT_OWNERS
    );

    if (!isAuthorized) {
        return message.reply({ content: '❌ **خوي.**', ephemeral: true });
    }

    const { embed, row } = await getVacationsListEmbed(message.guild);
    await message.reply({ embeds: [embed], components: [row] });
}

/**
 * جلب قائمة الإجازات النشطة مع تحسين عرض البيانات
 */
async function getVacationsListEmbed(guild) {
    const vacations = readJson(vacationsPath, { active: {} });
    const active = vacations.active || {};
    
    const embed = colorManager.createEmbed()
        .setTitle('🌴 لوحة تحكم الإجازات الإدارية')
        .setColor(colorManager.getColor('active') || '#0099ff')
        .setFooter({ text: `إجمالي الإجازات النشطة: ${Object.keys(active).length}` })
        .setTimestamp();

    let description = '';
    const activeEntries = Object.entries(active);
    
    if (activeEntries.length === 0) {
        description = '```diff\n- لا يوجد إداريين في إجازة حالياً.\n```';
    } else {
        activeEntries.forEach(([userId, data], index) => {
            const endTimestamp = Math.floor(new Date(data.endDate).getTime() / 1000);
            const roles = data.rolesData ? data.rolesData.map(r => `<@&${r.id}>`).join(' ') : '`غير محدد`';
            description += `**${index + 1}.** <@${userId}>\n┗ الرولات: ${roles}\n┗ ينتهي: <t:${endTimestamp}:R> (<t:${endTimestamp}:d>)\n\n`;
        });
    }

    embed.setDescription(description || 'خطأ في تحميل البيانات');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('vac_list_pending')
            .setLabel('الطلبات المعلقة')
            .setEmoji('⏳')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('vac_list_pending_term')
            .setLabel('طلبات الإنهاء')
            .setEmoji('⏰')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('vac_list_terminate')
            .setLabel('إنهاء فوري')
            .setEmoji('🛑')
            .setStyle(ButtonStyle.Danger)
    );

    return { embed, row };
}

/**
 * جلب قائمة الطلبات المعلقة مع حساب المدة بدقة
 */
async function getPendingListEmbed(guild) {
    const vacations = readJson(vacationsPath, { pending: {} });
    const pending = vacations.pending || {};
    
    const embed = colorManager.createEmbed()
        .setTitle('⏳ طلبات الإجازة المعلقة')
        .setColor(colorManager.getColor('pending') || '#E67E22')
        .setFooter({ text: `إجمالي الطلبات: ${Object.keys(pending).length}` })
        .setTimestamp();

    let description = '';
    const pendingEntries = Object.entries(pending);

    if (pendingEntries.length === 0) {
        description = '```diff\n- لا توجد طلبات معلقة حالياً.\n```';
    } else {
        pendingEntries.forEach(([userId, data], index) => {
            const start = new Date(data.startDate);
            const end = new Date(data.endDate);
            const days = Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)));
            description += `**${index + 1}.** <@${userId}>\n┗ المدة: \`${days} يوم\`\n┗ السبب: \`${data.reason}\`\n\n`;
        });
    }

    embed.setDescription(description || 'خطأ في تحميل البيانات');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('vac_list_back')
            .setLabel('رجوع')
            .setEmoji('🔙')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('vac_pending_approve_multi')
            .setLabel('قبول متعدد')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success)
            .setDisabled(pendingEntries.length === 0),
        new ButtonBuilder()
            .setCustomId('vac_pending_reject_multi')
            .setLabel('رفض متعدد')
            .setEmoji('❌')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(pendingEntries.length === 0)
    );

    return { embed, row };
}

/**
 * جلب قائمة طلبات إنهاء الإجازة المعلقة
 */
async function getPendingTerminationListEmbed(guild) {
    const vacations = readJson(vacationsPath, { pendingTermination: {} });
    const pending = vacations.pendingTermination || {};
    
    const embed = colorManager.createEmbed()
        .setTitle('⏰ طلبات إنهاء الإجازة المعلقة')
        .setColor(colorManager.getColor('pending') || '#E67E22')
        .setFooter({ text: `إجمالي الطلبات: ${Object.keys(pending).length}` })
        .setTimestamp();

    let description = '';
    const pendingEntries = Object.entries(pending);

    if (pendingEntries.length === 0) {
        description = '```diff\n- لا توجد طلبات إنهاء معلقة حالياً.\n```';
    } else {
        pendingEntries.forEach(([userId, data], index) => {
            description += `**${index + 1}.** <@${userId}>\n┗ السبب الأصلي: \`${data.reason || 'غير محدد'}\`\n┗ تاريخ الطلب: <t:${Math.floor(new Date(data.terminationRequestedAt).getTime() / 1000)}:R>\n\n`;
        });
    }

    embed.setDescription(description || 'خطأ في تحميل البيانات');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('vac_list_back')
            .setLabel('رجوع')
            .setEmoji('🔙')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('vac_term_approve_multi')
            .setLabel('قبول الإنهاء')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success)
            .setDisabled(pendingEntries.length === 0),
        new ButtonBuilder()
            .setCustomId('vac_term_reject_multi')
            .setLabel('رفض الإنهاء')
            .setEmoji('❌')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(pendingEntries.length === 0)
    );

    return { embed, row };
}

async function handleInteraction(interaction, context) {
    const { client, BOT_OWNERS } = context;
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

    const isOwner = isBotOwner(interaction.user.id, BOT_OWNERS);
    const settings = vacationManager.getSettings();
    const isAuthorized = isOwner || await vacationManager.isUserAuthorizedApprover(
        interaction.user.id,
        interaction.guild,
        settings,
        BOT_OWNERS
    );

    if (!isAuthorized) {
        return interaction.reply({ content: '❌ **خوي.**', ephemeral: true });
    }

    try {
        // --- التنقل بين القوائم ---
        if (interaction.customId === 'vac_list_pending') {
            const { embed, row } = await getPendingListEmbed(interaction.guild);
            return await interaction.update({ embeds: [embed], components: [row] });
        }

        if (interaction.customId === 'vac_list_pending_term') {
            const { embed, row } = await getPendingTerminationListEmbed(interaction.guild);
            return await interaction.update({ embeds: [embed], components: [row] });
        }

        if (interaction.customId === 'vac_list_back') {
            const { embed, row } = await getVacationsListEmbed(interaction.guild);
            return await interaction.update({ content: null, embeds: [embed], components: [row] });
        }

        // --- إنهاء الإجازة ---
        if (interaction.customId === 'vac_list_terminate') {
            const vacations = readJson(vacationsPath, { active: {} });
            const active = vacations.active || {};
            const entries = Object.entries(active);

            if (entries.length === 0) {
                return interaction.reply({ content: '❌ لا توجد إجازات نشطة لإنهائها.', ephemeral: true });
            }

            const options = entries.map(([userId, data]) => ({
                label: data.memberData?.displayName || userId,
                description: `ID: ${userId}`,
                value: userId
            })).slice(0, 25);

            const menu = new StringSelectMenuBuilder()
                .setCustomId('vac_terminate_select')
                .setPlaceholder('اختر الإداريين لإنهاء إجازتهم')
                .setMinValues(1)
                .setMaxValues(options.length)
                .addOptions(options);

            const row = new ActionRowBuilder().addComponents(menu);
            const backRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('vac_list_back').setLabel('رجوع').setStyle(ButtonStyle.Secondary)
            );

            return await interaction.update({ content: '⚠️ **اختر من القائمة لإنهاء الإجازة فوراً:**', embeds: [], components: [row, backRow] });
        }

        if (interaction.customId === 'vac_terminate_select') {
            await interaction.deferUpdate();
            const userIds = interaction.values;
            let results = [];
            
            for (const userId of userIds) {
                try {
                    const res = await vacationManager.endVacation(interaction.guild, client, userId, `تم الإنهاء بواسطة الأونر: ${interaction.user.tag}`);
                    results.push(`<@${userId}>: ${res.success ? '✅ تم' : '❌ فشل'}`);
                } catch (e) {
                    results.push(`<@${userId}>: ⚠️ خطأ تقني`);
                }
            }

            const { embed, row } = await getVacationsListEmbed(interaction.guild);
            return await interaction.editReply({ 
                content: `**📊 نتائج معالجة الإنهاء:**\n${results.join('\n')}`, 
                embeds: [embed], 
                components: [row] 
            });
        }

        // --- القبول المتعدد ---
        if (interaction.customId === 'vac_pending_approve_multi') {
            const vacations = readJson(vacationsPath, { pending: {} });
            const pending = vacations.pending || {};
            const entries = Object.entries(pending);

            if (entries.length === 0) return interaction.reply({ content: '❌ لا توجد طلبات معلقة.', ephemeral: true });

            const options = entries.map(([userId, data]) => ({
                label: `طلب: ${userId}`,
                description: `السبب: ${data.reason.substring(0, 50)}`,
                value: userId
            })).slice(0, 25);

            const menu = new StringSelectMenuBuilder()
                .setCustomId('vac_pending_approve_select')
                .setPlaceholder('اختر الطلبات لقبولها')
                .setMinValues(1)
                .setMaxValues(options.length)
                .addOptions(options);

            const row = new ActionRowBuilder().addComponents(menu);
            const backRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('vac_list_pending').setLabel('رجوع').setStyle(ButtonStyle.Secondary)
            );

            return await interaction.update({ content: '✅ **اختر الطلبات للموافقة الجماعية:**', embeds: [], components: [row, backRow] });
        }

        if (interaction.customId === 'vac_pending_approve_select') {
            await interaction.deferUpdate();
            const userIds = interaction.values;
            let results = [];
            
            for (const userId of userIds) {
                try {
                    const res = await vacationManager.approveVacation(interaction, userId, interaction.user.id);
                    if (res.success) {
                        // تحديث الرسالة الأصلية
                        await updateOriginalMessage(interaction.guild, userId, 'vacation', 'approved', { adminId: interaction.user.id });

                        const member = await interaction.guild.members.fetch(userId).catch(() => null);
                        if (member) {
                            const dmEmbed = colorManager.createEmbed()
                                .setTitle('✅ تم قبول طلب إجازتك')
                                .setColor('#2ECC71')
                                .setDescription(`أهلاً بك، لقد تمت الموافقة على طلب إجازتك في **${interaction.guild.name}**.\nتم سحب رولاتك الإدارية مؤقتاً.`)
                                .setTimestamp();
                            await member.user.send({ embeds: [dmEmbed] }).catch(() => {});
                        }
                    }
                    results.push(`<@${userId}>: ${res.success ? '✅ تم القبول' : '❌ فشل'}`);
                } catch (error) {
                    console.error('[Vacations] Bulk approve error:', error);
                    results.push(`<@${userId}>: ❌ خطأ`);
                }
            }

            const { embed, row } = await getPendingListEmbed(interaction.guild);
            return await interaction.editReply({ 
                content: `**📊 نتائج القبول الجماعي:**\n${results.join('\n')}`, 
                embeds: [embed], 
                components: [row] 
            });
        }

        // --- الرفض المتعدد ---
        if (interaction.customId === 'vac_pending_reject_multi') {
            const vacations = readJson(vacationsPath, { pending: {} });
            const pending = vacations.pending || {};
            const entries = Object.entries(pending);

            if (entries.length === 0) return interaction.reply({ content: '❌ لا توجد طلبات معلقة.', ephemeral: true });

            const options = entries.map(([userId, data]) => ({
                label: `طلب: ${userId}`,
                description: `السبب: ${data.reason.substring(0, 50)}`,
                value: userId
            })).slice(0, 25);

            const menu = new StringSelectMenuBuilder()
                .setCustomId('vac_pending_reject_select')
                .setPlaceholder('اختر الطلبات لرفضها')
                .setMinValues(1)
                .setMaxValues(options.length)
                .addOptions(options);

            const row = new ActionRowBuilder().addComponents(menu);
            const backRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('vac_list_pending').setLabel('رجوع').setStyle(ButtonStyle.Secondary)
            );

            return await interaction.update({ content: '❌ **اختر الطلبات للرفض الجماعي:**', embeds: [], components: [row, backRow] });
        }

        if (interaction.customId === 'vac_pending_reject_select') {
            await interaction.deferUpdate();
            const userIds = interaction.values;
            let results = [];
            
            for (const userId of userIds) {
                try {
                    const res = await rejectVacation(interaction, userId);
                    results.push(`<@${userId}>: ${res.success ? '❌ تم الرفض' : '❌ فشل'}`);
                } catch (error) {
                    console.error('[Vacations] Bulk reject error:', error);
                    results.push(`<@${userId}>: ❌ خطأ`);
                }
            }

            const { embed, row } = await getPendingListEmbed(interaction.guild);
            return await interaction.editReply({ 
                content: `**📊 نتائج الرفض الجماعي:**\n${results.join('\n')}`, 
                embeds: [embed], 
                components: [row] 
            });
        }

        // --- القبول المتعدد للإنهاء ---
        if (interaction.customId === 'vac_term_approve_multi') {
            const vacations = readJson(vacationsPath, { pendingTermination: {} });
            const pending = vacations.pendingTermination || {};
            const entries = Object.entries(pending);

            if (entries.length === 0) return interaction.reply({ content: '❌ لا توجد طلبات إنهاء معلقة.', ephemeral: true });

            const options = entries.map(([userId, data]) => ({
                label: `إنهاء: ${userId}`,
                description: `السبب: ${data.reason?.substring(0, 50) || 'غير محدد'}`,
                value: userId
            })).slice(0, 25);

            const menu = new StringSelectMenuBuilder()
                .setCustomId('vac_term_approve_select')
                .setPlaceholder('اختر الطلبات لقبول إنهاء إجازتها')
                .setMinValues(1)
                .setMaxValues(options.length)
                .addOptions(options);

            const row = new ActionRowBuilder().addComponents(menu);
            const backRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('vac_list_pending_term').setLabel('رجوع').setStyle(ButtonStyle.Secondary)
            );

            return await interaction.update({ content: '✅ **اختر طلبات الإنهاء للموافقة الجماعية:**', embeds: [], components: [row, backRow] });
        }

        if (interaction.customId === 'vac_term_approve_select') {
            await interaction.deferUpdate();
            const userIds = interaction.values;
            let results = [];
            
            for (const userId of userIds) {
                try {
                    const res = await vacationManager.endVacation(interaction.guild, client, userId, `تم قبول الإنهاء بواسطة المسؤول: ${interaction.user.tag}`);
                    if (res.success) {
                        // تحديث الرسالة الأصلية
                        await updateOriginalMessage(interaction.guild, userId, 'termination', 'approved', { adminId: interaction.user.id });

                        const currentVacations = readJson(vacationsPath);
                        if (currentVacations.pendingTermination) delete currentVacations.pendingTermination[userId];
                        writeJson(vacationsPath, currentVacations);

                        const member = await interaction.guild.members.fetch(userId).catch(() => null);
                        if (member) {
                            const dmEmbed = colorManager.createEmbed()
                                .setTitle('✅ تم قبول إنهاء إجازتك')
                                .setColor('#2ECC71')
                                .setDescription(`أهلاً بك، لقد تمت الموافقة على طلب إنهاء إجازتك مبكراً في **${interaction.guild.name}**.\nتمت استعادة رولاتك بنجاح.`)
                                .setTimestamp();
                            await member.user.send({ embeds: [dmEmbed] }).catch(() => {});
                        }
                    }
                    results.push(`<@${userId}>: ${res.success ? '✅ تم الإنهاء' : '❌ فشل'}`);
                } catch (error) {
                    console.error('[Vacations] Bulk termination approve error:', error);
                    results.push(`<@${userId}>: ❌ خطأ`);
                }
            }

            const { embed, row } = await getPendingTerminationListEmbed(interaction.guild);
            return await interaction.editReply({ 
                content: `**📊 نتائج قبول الإنهاء الجماعي:**\n${results.join('\n')}`, 
                embeds: [embed], 
                components: [row] 
            });
        }

        // --- الرفض المتعدد للإنهاء ---
        if (interaction.customId === 'vac_term_reject_multi') {
            const vacations = readJson(vacationsPath, { pendingTermination: {} });
            const pending = vacations.pendingTermination || {};
            const entries = Object.entries(pending);

            if (entries.length === 0) return interaction.reply({ content: '❌ لا توجد طلبات إنهاء معلقة.', ephemeral: true });

            const options = entries.map(([userId, data]) => ({
                label: `رفض إنهاء: ${userId}`,
                description: `السبب: ${data.reason?.substring(0, 50) || 'غير محدد'}`,
                value: userId
            })).slice(0, 25);

            const menu = new StringSelectMenuBuilder()
                .setCustomId('vac_term_reject_select')
                .setPlaceholder('اختر الطلبات لرفض إنهاء إجازتها')
                .setMinValues(1)
                .setMaxValues(options.length)
                .addOptions(options);

            const row = new ActionRowBuilder().addComponents(menu);
            const backRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('vac_list_pending_term').setLabel('رجوع').setStyle(ButtonStyle.Secondary)
            );

            return await interaction.update({ content: '❌ **اختر طلبات الإنهاء للرفض الجماعي:**', embeds: [], components: [row, backRow] });
        }

        if (interaction.customId === 'vac_term_reject_select') {
            await interaction.deferUpdate();
            const userIds = interaction.values;
            let results = [];
            
            for (const userId of userIds) {
                try {
                    const res = await rejectTermination(interaction, userId);
                    results.push(`<@${userId}>: ${res.success ? '❌ تم الرفض' : '❌ فشل'}`);
                } catch (error) {
                    console.error('[Vacations] Bulk termination reject error:', error);
                    results.push(`<@${userId}>: ❌ خطأ`);
                }
            }

            const { embed, row } = await getPendingTerminationListEmbed(interaction.guild);
            return await interaction.editReply({ 
                content: `**📊 نتائج رفض الإنهاء الجماعي:**\n${results.join('\n')}`, 
                embeds: [embed], 
                components: [row] 
            });
        }

    } catch (error) {
        console.error('[Vacations] Interaction Error:', error);
        const errorMsg = { content: '⚠️ حدث خطأ تقني أثناء معالجة الطلب، يرجى مراجعة الكونسول.', ephemeral: true };
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(errorMsg).catch(() => null);
        } else {
            await interaction.reply(errorMsg).catch(() => null);
        }
    }
}

/**
 * تحديث الرسالة الأصلية في روم الإجازات
 */
async function updateOriginalMessage(guild, userId, type, status, data = {}) {
    try {
        const settings = vacationManager.getSettings();
        if (!settings.notificationChannel) return;

        const channel = await guild.channels.fetch(settings.notificationChannel).catch(() => null);
        if (!channel) return;

        const messages = await channel.messages.fetch({ limit: 50 }).catch(() => []);
        const targetMsg = messages.find(m => {
            if (m.author.id !== guild.client.user.id) return false;
            if (m.components.length === 0) return false;
            
            const customId = m.components[0].components[0]?.customId;
            if (!customId) return false;

            if (type === 'vacation') {
                return customId.includes(`vac_approve_${userId}`) || customId.includes(`vac_reject_${userId}`);
            } else if (type === 'termination') {
                return customId.includes(`vac_approve_termination_${userId}`) || customId.includes(`vac_reject_termination_${userId}`);
            }
            return false;
        });

        if (targetMsg) {
            const embed = EmbedBuilder.from(targetMsg.embeds[0]);
            if (status === 'approved') {
                embed.setTitle(type === 'vacation' ? '✅ تم قبول طلب الإجازة' : '✅ تم قبول إنهاء الإجازة')
                     .setColor(colorManager.getColor('approved') || '#2ECC71')
                     .addFields({ name: "المسؤول (عبر لوحة التحكم)", value: `<@${data.adminId}>`, inline: true });
            } else {
                embed.setTitle(type === 'vacation' ? '❌ تم رفض طلب الإجازة' : '❌ تم رفض إنهاء الإجازة')
                     .setColor(colorManager.getColor('rejected') || '#E74C3C')
                     .addFields({ name: "المسؤول (عبر لوحة التحكم)", value: `<@${data.adminId}>`, inline: true });
            }
            await targetMsg.edit({ embeds: [embed], components: [] }).catch(() => null);
        }
    } catch (error) {
        console.error('[Vacations] Error updating original message:', error);
    }
}

/**
 * دالة رفض الإجازة مع تحسينات الأمان والرسائل
 */
async function rejectVacation(interaction, userId) {
    try {
        const vacationsData = readJson(vacationsPath, { pending: {}, rejected: {}, cooldowns: {} });
        const pendingRequest = vacationsData.pending?.[userId];

        if (!pendingRequest) return { success: false };

        const settings = vacationManager.getSettings();
        const rejectCooldownHours = Number.isFinite(settings.rejectCooldownHours) ? settings.rejectCooldownHours : 12;
        const COOLDOWN_TIME = rejectCooldownHours * 60 * 60 * 1000;
        if (!vacationsData.cooldowns) vacationsData.cooldowns = {};
        vacationsData.cooldowns[userId] = Date.now() + COOLDOWN_TIME;

        // أرشفة الطلب المرفوض
        if (!vacationsData.rejected) vacationsData.rejected = {};
        vacationsData.rejected[userId] = {
            ...pendingRequest,
            rejectedBy: interaction.user.id,
            rejectedAt: new Date().toISOString(),
        };
        
        delete vacationsData.pending[userId];
        writeJson(vacationsPath, vacationsData);

        // تحديث الرسالة الأصلية
        await updateOriginalMessage(interaction.guild, userId, 'vacation', 'rejected', { adminId: interaction.user.id });

        // إشعار العضو
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (member) {
            const dmEmbed = colorManager.createEmbed()
                .setTitle('❌ تحديث بشأن طلب إجازتك')
                .setColor('#E74C3C')
                .setDescription(`**نأسف لإبلاغك بأنه تم رفض طلب إجازتك.**\n\n**السبب المذكور:** \`${pendingRequest.reason}\`\n**ملاحظة:** يمكنك التقديم مرة أخرى بعد مرور ${rejectCooldownHours} ساعة.`)
                .setTimestamp();
            await member.user.send({ embeds: [dmEmbed] }).catch(() => {});
        }

        return { success: true };
    } catch (error) {
        console.error('[Vacations] Reject Function Error:', error);
        return { success: false };
    }
}

/**
 * دالة رفض إنهاء الإجازة
 */
async function rejectTermination(interaction, userId) {
    try {
        const vacationsData = readJson(vacationsPath, { pendingTermination: {}, cooldowns: {} });
        const pendingRequest = vacationsData.pendingTermination?.[userId];

        if (!pendingRequest) return { success: false };

        const settings = vacationManager.getSettings();
        const rejectCooldownHours = Number.isFinite(settings.rejectCooldownHours) ? settings.rejectCooldownHours : 12;
        const COOLDOWN_TIME = rejectCooldownHours * 60 * 60 * 1000;
        if (!vacationsData.cooldowns) vacationsData.cooldowns = {};
        vacationsData.cooldowns[userId] = Date.now() + COOLDOWN_TIME;

        delete vacationsData.pendingTermination[userId];
        writeJson(vacationsPath, vacationsData);

        // تحديث الرسالة الأصلية
        await updateOriginalMessage(interaction.guild, userId, 'termination', 'rejected', { adminId: interaction.user.id });

        // إشعار العضو
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (member) {
            const dmEmbed = colorManager.createEmbed()
                .setTitle('❌ تم رفض طلب إنهاء إجازتك المبكر')
                .setColor('#E74C3C')
                .setDescription(`نعتذر، لقد تم رفض طلب إنهاء الإجازة الخاص بك في **${interaction.guild.name}**.\n\n**ملاحظة:** يمكنك المحاولة مرة أخرى بعد مرور ${rejectCooldownHours} ساعة.`)
                .setTimestamp();
            await member.user.send({ embeds: [dmEmbed] }).catch(() => {});
        }

        return { success: true };
    } catch (error) {
        console.error('[Vacations] Reject Termination Error:', error);
        return { success: false };
    }
}

module.exports = {
    name: 'اجازات',
    description: 'نظام إدارة الإجازات الإدارية (خاص بالأونر)',
    execute,
    handleInteraction
};
