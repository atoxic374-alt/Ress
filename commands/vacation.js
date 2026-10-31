const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SectionBuilder, ThumbnailBuilder } = require('discord.js');
const fs = require('fs');
const ms = require('ms');
const colorManager = require('../utils/colorManager.js');
const vacationManager = require('../utils/vacationManager.js');
const { createDecisionContainer, decisionPayload } = require('../utils/decisionContainer.js');
const { getDataFilePath } = require('../utils/storagePaths.js');

const adminRolesPath = getDataFilePath('adminRoles.json');
const responsibilitiesPath = getDataFilePath('responsibilities.json');
const vacationsPath = getDataFilePath('vacations.json');

function vacationAccentColor() {
    const colorText = String(colorManager.getColor?.() || '#0099ff')
        .replace(/^#/, '').replace(/^0x/i, '');
    const color = Number.parseInt(colorText, 16);
    return Number.isFinite(color) ? color : 0x0099ff;
}

function createVacationContainer({ title, lines = [], member = null, footer = 'Vacation System' }) {
    const avatar = member?.user?.displayAvatarURL({ extension: 'png', size: 128 })
        || member?.displayAvatarURL?.({ extension: 'png', size: 128 })
        || 'https://cdn.discordapp.com/embed/avatars/0.png';
    const section = new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${title}`))
        .setThumbnailAccessory(new ThumbnailBuilder()
            .setURL(avatar)
            .setDescription(`صورة ${member?.displayName || 'المتقدم'}`));
    return new ContainerBuilder()
        .setAccentColor(vacationAccentColor())
        .addSectionComponents(section)
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n\n')))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footer}`));
}

// Helper to read a JSON file
function readJson(filePath, defaultData = {}) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (error) {
        console.error(`Error reading ${filePath}:`, error);
    }
    return defaultData;
}

async function execute(message, args, { BOT_OWNERS }) {
    const member = message.member;
    const adminRoles = readJson(adminRolesPath, []);
    const isOwner = BOT_OWNERS.includes(message.author.id);
    const hasAdminRole = member.roles.cache.some(role => adminRoles.includes(role.id));

    const replyEmbed = new EmbedBuilder().setColor(colorManager.getColor() || '#0099ff');

    if (!isOwner && !hasAdminRole) {
        replyEmbed.setDescription('❌ **خوي.**');
        return message.reply({ embeds: [replyEmbed], ephemeral: true });
    }

    const settings = vacationManager.getSettings();
    if (!settings || !settings.approverType || !settings.notificationMethod) {
        replyEmbed.setDescription('⚠️ نظام الاجازات باقي محد سواه.');
        return message.reply({ embeds: [replyEmbed], ephemeral: true });
    }

    // التحقق من وجود المسؤولية والمسؤولين إذا كان نوع المعتمد هو مسؤولية
    if (settings.approverType === 'responsibility') {
        const responsibilities = readJson(responsibilitiesPath, {});
        for (const respName of settings.approverTargets || []) {
            const respData = responsibilities[respName];
            if (!respData) {
                replyEmbed.setDescription(`❌ **المسؤولية "${respName}" غير موجودة! يرجى إعداد النظام مرة أخرى.**`);
                return message.reply({ embeds: [replyEmbed], ephemeral: true });
            }
            if (!respData.responsibles || respData.responsibles.length === 0) {
                replyEmbed.setDescription(`❌ **المسؤولية "${respName}" لا تحتوي على أي مسؤولين! يرجى إضافة مسؤولين أولاً.**`);
                return message.reply({ embeds: [replyEmbed], ephemeral: true });
            }
        }
    }

    if (vacationManager.isUserOnVacation(member.id)) {
        replyEmbed.setDescription("You are already on vacation.");
        return message.reply({ embeds: [replyEmbed], ephemeral: true });
    }

    const vacations = readJson(vacationsPath);
    
    // التحقق من الكولداون (12 ساعة)
    if (vacations.cooldowns?.[member.id]) {
        const cooldownTime = vacations.cooldowns[member.id];
        if (Date.now() < cooldownTime) {
            const timeLeft = cooldownTime - Date.now();
            const hours = Math.floor(timeLeft / (1000 * 60 * 60));
            const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
            
            replyEmbed.setDescription(`❌ **عليك كولداون حالياً.\nالمتبقي : ${hours}h , ${minutes}m.**`)
                       .setThumbnail(member.user.displayAvatarURL({ size: 128 }));
            return message.reply({ embeds: [replyEmbed], ephemeral: true });
        } else {
            // تنظيف الكولداون المنتهي
            delete vacations.cooldowns[member.id];
            vacationManager.saveVacations(vacations);
        }
    }

    if (vacations.pending?.[member.id]) {
        replyEmbed.setDescription("You already have a pending vacation request.");
        return message.reply({ embeds: [replyEmbed], ephemeral: true });
    }

    const vacationPanel = createVacationContainer({
        title: 'Vacation Request',
        lines: [
            '**اضغط على الزر أدناه لتقديم طلب إجازة للمسؤولين.**',
            `**Applicant :** <@${member.id}>`
        ],
        member,
        footer: 'Vacation System • Request'
    });
    const requestButton = new ButtonBuilder()
        .setCustomId(`vac_request_start_${member.id}`)
        .setLabel("Vacation")
    .setEmoji("<:emoji_20:1457509216443957431>")
        .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(requestButton);
    await message.reply({
        components: [vacationPanel, row],
        flags: MessageFlags.IsComponentsV2
    });
}

async function handleInteraction(interaction, context) {
    const { client, BOT_OWNERS } = context;
    const customId = interaction.customId;

    const replyEmbed = new EmbedBuilder().setColor(colorManager.getColor() || '#0099ff');

    if (interaction.isButton() && customId.startsWith('vac_request_start_')) {
        const userId = customId.split('_').pop();
        if (interaction.user.id !== userId) {
            replyEmbed.setDescription("You can only request a vacation for yourself.");
            return interaction.reply({ embeds: [replyEmbed], ephemeral: true });
        }

        const modal = new ModalBuilder()
            .setCustomId(`vac_request_modal_${userId}`)
            .setTitle('Vacation Request Form');

        const durationInput = new TextInputBuilder().setCustomId('vac_duration').setLabel("المدة (مثل: 7d أو 12h أو 30m)").setStyle(TextInputStyle.Short).setRequired(true);
        const reasonInput = new TextInputBuilder().setCustomId('vac_reason').setLabel("Reason").setStyle(TextInputStyle.Paragraph).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(durationInput), new ActionRowBuilder().addComponents(reasonInput));

        await interaction.showModal(modal);

        // لا نقوم بتحديث الرسالة هنا، سيتم التحديث بعد إرسال الطلب بنجاح

    }

    if (interaction.isModalSubmit() && customId.startsWith('vac_request_modal_')) {
        try {
            const userId = customId.split('_').pop();
            const member = await interaction.guild.members.fetch(userId);
            const durationStr = interaction.fields.getTextInputValue('vac_duration').trim();
            const reason = interaction.fields.getTextInputValue('vac_reason');

            // فحص التنسيق المسموح (رقم + d/h/m فقط)
            const durationRegex = /^(\d+)(d|h|m)$/i;
            const match = durationStr.match(durationRegex);

            if (!match) {
                replyEmbed.setDescription('❌ **صيغة المدة غير صحيحة!** \nيرجى استخدام:\n• `رقم+d` للأيام (مثل: 7d)\n• `رقم+h` للساعات (مثل: 12h)\n• `رقم+m` للدقائق (مثل: 30m)\n\n**مثال:** `3d` للإجازة لمدة 3 أيام');
                return interaction.reply({ embeds: [replyEmbed], ephemeral: true });
            }

            const durationMs = ms(durationStr);
            if (!durationMs || durationMs <= 0) {
                replyEmbed.setDescription('❌ **صيغة المدة غير صحيحة.** يرجى التأكد من أن المدة صحيحة.');
                return interaction.reply({ embeds: [replyEmbed], ephemeral: true });
            }

            // Get and validate settings first
            const settings = vacationManager.getSettings();
            if (!settings.approverType) {
                return interaction.reply({
                    content: '**نظام الإجازات غير مُعد بعد! يرجى استخدام أمر `set-vacation` لإعداد النظام أولاً.**',
                    ephemeral: true
                });
            }

            // التحقق من وجود طلب إجازة معلق مسبقاً
            const existingVacations = readJson(vacationsPath);
            if (existingVacations.pending?.[userId]) {
                return interaction.reply({
                    content: '❌ **لديك طلب إجازة معلق بالفعل! لا يمكنك تقديم طلب آخر.**',
                    ephemeral: true
                });
            }

            if (vacationManager.isUserOnVacation(userId)) {
                return interaction.reply({
                    content: '❌ **أنت في إجازة حالياً! لا يمكنك تقديم طلب إجازة جديد.**',
                    ephemeral: true
                });
            }

            // Check for responsibles in the selected responsibility
            if (settings.approverType === 'responsibility') {
                const responsibilities = readJson(responsibilitiesPath, {});
                for (const respName of settings.approverTargets) {
                    const respData = responsibilities[respName];
                    if (!respData) {
                        return interaction.reply({
                            content: `**المسؤولية "${respName}" غير موجودة!**`,
                            ephemeral: true
                        });
                    }
                    if (!respData.responsibles || respData.responsibles.length === 0) {
                        return interaction.reply({
                            content: `**المسؤولية "${respName}" لا تحتوي على أي مسؤولين! يرجى إضافة مسؤولين أولاً.**`,
                            ephemeral: true
                        });
                    }
                }
            }

            const approvers = await vacationManager.getApprovers(interaction.guild, settings, BOT_OWNERS);

            if (approvers.length === 0) {
                let errorMessage = 'لا يمكن العثور على أي معتمدين صالحين بناءً على الإعدادات الحالية.';

                if (settings.approverType === 'responsibility') {
                    errorMessage += ' يرجى التأكد من وجود مسؤولين في المسؤولية المحددة وأنهم موجودين.';
                } else if (settings.approverType === 'role') {
                    errorMessage += ' يرجى التأكد من وجود أعضاء في لرولات المحددة.';
                }

                return interaction.reply({ content: errorMessage, ephemeral: true });
            }

            // Save vacation request
            const vacations = readJson(vacationsPath);
            if (!vacations.pending) {
                vacations.pending = {};
            }
            vacations.pending[userId] = {
                reason: reason,
                startDate: new Date().toISOString(),
                endDate: new Date(Date.now() + durationMs).toISOString(),
            };
            vacationManager.saveVacations(vacations);


            // Send notification to approvers
            const adminRoles = readJson(adminRolesPath, []);
            const rolesToBeRemoved = member.roles.cache.filter(role => adminRoles.includes(role.id));
            const rolesDisplay = rolesToBeRemoved.map(r => `<@&${r.id}>`).join(', ') || 'لا توجد';

            const vacationContainer = createVacationContainer({
                title: 'Vacation Pending',
                lines: [
                    '**Status :** معلق',
                    `**Applicant :** <@${member.id}>`,
                    `**Duration :** ${ms(durationMs, { long: true })}`,
                    `**Reason :** ${reason}`,
                    `**Roles to Remove :** ${rolesDisplay}`
                ],
                member,
                footer: 'Vacation System • Pending'
            });

            const buttons = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`vac_approve_${userId}`).setLabel("Allow?").setEmoji('<:emoji_41:1430334120839479449>').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`vac_reject_${userId}`).setLabel("Deny?").setEmoji('<:emoji_45:1430334556078211082>').setStyle(ButtonStyle.Danger)
            );

            // Send notifications
            if (settings.notificationMethod === 'channel' && settings.notificationChannel) {
                const channel = await client.channels.fetch(settings.notificationChannel).catch(() => null);
                if (channel) {
                    await channel.send({ components: [vacationContainer, buttons], flags: MessageFlags.IsComponentsV2 });
                }
            } else { // DM by default
                for (const approver of approvers) {
                    await approver.send({ components: [vacationContainer, buttons], flags: MessageFlags.IsComponentsV2 }).catch(e =>
                        console.error(`Could not DM user ${approver.id}: ${e.message}`)
                    );
                }
            }

            // تعطيل الزر في الرسالة الأصلية
            try {
                const originalMessage = await interaction.message.fetch();
                const disabledButton = new ButtonBuilder()
                    .setCustomId(`vac_request_used_${userId}`)
                    .setLabel("Done")
                .setEmoji('<:emoji_41:1430334120839479449>')
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(true);

                const disabledRow = new ActionRowBuilder().addComponents(disabledButton);
                await originalMessage.edit({ components: [disabledRow] });
            } catch (error) {
                console.error('فشل في تعطيل الزر:', error);
            }

            // Send success response to user
            replyEmbed.setDescription('✅ **تم إرسال طلب الإجازة للمعتمدين بنجاح.**');
            await interaction.reply({ embeds: [replyEmbed], ephemeral: true });

        } catch (error) {
            console.error("Error in vacation modal submission:", error);
            const errorEmbed = new EmbedBuilder().setColor('#FF0000')
                .setDescription(`**حدث خطأ أثناء إرسال طلبك:**\n\`\`\`${error.message}\`\`\``);

            if (interaction.replied || interaction.deferred) {
                await interaction.editReply({ embeds: [errorEmbed] });
            } else {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }
        }
    }

    // Handle regular vacation approvals and rejections
    if (interaction.isButton() && (interaction.customId.startsWith('vac_approve_') || interaction.customId.startsWith('vac_reject_'))) {
        const parts = interaction.customId.split('_');
        const action = parts[1]; // approve or reject
        const userId = parts[2];

        // فحص الصلاحيات قبل السماح بالموافقة/الرفض
        const vacationSettings = vacationManager.getSettings();
        const isAuthorizedApprover = await vacationManager.isUserAuthorizedApprover(
            interaction.user.id,
            interaction.guild,
            vacationSettings,
            BOT_OWNERS
        );

        if (!isAuthorizedApprover) {
            return interaction.reply({ 
                content: '❌ ** خوي ها؟.**', 
                ephemeral: true 
            });
        }

        // تأجيل الرد فقط للموافقة، أما الرفض فيحتاج لإظهار نافذة Modal
        if (interaction.customId.startsWith('vac_approve_')) {
            await interaction.deferUpdate().catch(() => {});
        }

        const vacationsData = readJson(vacationsPath);
        const pendingRequest = vacationsData.pending?.[userId];

        if (!pendingRequest) {
            const errorEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setDescription('❌ **لم يتم العثور على طلب إجازة معلق لهذا المستخدم.**');
            return interaction.editReply({ embeds: [errorEmbed] });
        }

        const member = await interaction.guild.members.fetch(userId);
        const approverMember = await interaction.guild.members.fetch(interaction.user.id);

        // Update vacation status and save
        if (action === 'approve') {
            const approveResult = await vacationManager.approveVacation(interaction, userId, interaction.user.id);
            
            if (!approveResult.success) {
                return interaction.editReply({ 
                    embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`❌ **فشل في قبول الإجازة:** ${approveResult.message}`)] 
                });
            }

            const successContainer = createDecisionContainer({
                approved: true,
                title: '✅ Vacation Accepted',
                targetMember: member,
                targetUserId: userId,
                actorId: interaction.user.id,
                guild: interaction.guild,
                details: [
                    `**Start Date :** ${new Date(pendingRequest.startDate).toLocaleString('en-US', { timeZone: 'Asia/Riyadh' })}`,
                    `**End Date :** ${new Date(pendingRequest.endDate).toLocaleString('en-US', { timeZone: 'Asia/Riyadh' })}`,
                    `**Reason :** ${pendingRequest.reason || 'Not specified'}`
                ],
                footer: 'Vacation System • Approved'
            });

            await interaction.editReply(decisionPayload(successContainer));

            // DM user
            try {
                const dmContainer = createDecisionContainer({
                    approved: true,
                    title: '✅ تم قبول طلب الإجازة',
                    targetMember: member,
                    targetUserId: userId,
                    actorId: interaction.user.id,
                    guild: interaction.guild,
                    details: [
                        `**Start Date :** ${new Date(pendingRequest.startDate).toLocaleString('en-US', { timeZone: 'Asia/Riyadh' })}`,
                        `**End Date :** ${new Date(pendingRequest.endDate).toLocaleString('en-US', { timeZone: 'Asia/Riyadh' })}`,
                        `**Reason :** ${pendingRequest.reason || 'Not specified'}`,
                        '**Note :** لإنهاء الإجازة مبكرًا اكتب `اجازتي`.'
                    ],
                    footer: 'Vacation System • Approved'
                });
                await member.user.send(decisionPayload(dmContainer));
            } catch (dmErr) {
                console.log('Could not DM user for approval');
            }

        } else if (action === 'reject') {
            const modal = new ModalBuilder()
                .setCustomId(`vac_reject_modal_${userId}`)
                .setTitle('Reject Vacation Request');

            const reasonInput = new TextInputBuilder()
                .setCustomId('reject_reason')
                .setLabel("Reason for Rejection")
                .setPlaceholder("Enter the reason why this vacation is being rejected...")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMinLength(5)
                .setMaxLength(500);

            const row = new ActionRowBuilder().addComponents(reasonInput);
            modal.addComponents(row);

            return interaction.showModal(modal);
        }
    }

    if (interaction.isModalSubmit() && customId.startsWith('vac_reject_modal_')) {
        // Only defer if not already replied or deferred
        if (!interaction.replied && !interaction.deferred) {
            await interaction.deferUpdate().catch(() => {});
        }
        const userId = customId.split('_').pop();
        const rejectReason = interaction.fields.getTextInputValue('reject_reason');

        const vacationsData = readJson(vacationsPath);
        const pendingRequest = vacationsData.pending?.[userId];

        if (!pendingRequest) {
            return interaction.followUp({ content: '❌ **No pending request found.**', ephemeral: true });
        }

        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        const approverMember = interaction.member;

        const settings = vacationManager.getSettings();
        const rejectCooldownHours = Number.isFinite(settings.rejectCooldownHours) ? settings.rejectCooldownHours : 12;

        // Add cooldown
        if (!vacationsData.cooldowns) vacationsData.cooldowns = {};
        vacationsData.cooldowns[userId] = Date.now() + (rejectCooldownHours * 60 * 60 * 1000);

        if (!vacationsData.rejected) vacationsData.rejected = {};
        vacationsData.rejected[userId] = {
            reason: pendingRequest.reason,
            rejectReason: rejectReason,
            startDate: pendingRequest.startDate,
            endDate: pendingRequest.endDate,
            rejectedBy: approverMember.user.tag,
            rejectedById: approverMember.id,
            rejectedAt: new Date().toISOString(),
        };
        delete vacationsData.pending[userId];
        vacationManager.saveVacations(vacationsData);

        const rejectContainer = createDecisionContainer({
            approved: false,
            title: '❌ Vacation Rejected',
            targetMember: member,
            targetUserId: userId,
            actorId: interaction.user.id,
            guild: interaction.guild,
                details: [
                    `**Rejection Reason :** ${rejectReason}`,
                    `**Original Reason :** ${pendingRequest.reason || 'Not specified'}`,
                    `**Cooldown :** ${rejectCooldownHours} hours`
            ],
            footer: 'Vacation System • Rejected'
        });

        await interaction.editReply(decisionPayload(rejectContainer));

        // DM user
        if (member) {
            try {
                const dmContainer = createDecisionContainer({
                    approved: false,
                    title: '❌ تم رفض طلب الإجازة',
                    targetMember: member,
                    targetUserId: userId,
                    actorId: interaction.user.id,
                    guild: interaction.guild,
                    details: [
                        `**Rejection Reason :** ${rejectReason}`,
                        `**Original Reason :** ${pendingRequest.reason || 'Not specified'}`,
                        `**Cooldown :** ${rejectCooldownHours} hours`
                    ],
                    footer: 'Vacation System • Rejected'
                });
                await member.user.send(decisionPayload(dmContainer));
            } catch (dmErr) {
                console.log('Could not DM user for rejection');
            }
        }
    }
}

module.exports = {
    name: 'اجازه',
    execute,
    handleInteraction
};
