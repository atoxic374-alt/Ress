const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelSelectMenuBuilder, RoleSelectMenuBuilder } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const fs = require('fs');
const path = require('path');
const ticketState = require('./ticket.js');

const name = 'report';
const reportsPath = path.join(__dirname, '..', 'data', 'reports.json');
const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');

const defaultGuildConfig = { enabled: false, pointsOnReport: false, reportChannel: null, requiredFor: [], approvalRequiredFor: [], templates: {}, approverType: 'owners', approverTargets: [] };

function loadReportsConfig(guildId) {
    try {
        if (fs.existsSync(reportsPath)) {
            const allConfigs = JSON.parse(fs.readFileSync(reportsPath, 'utf8'));
            return { ...defaultGuildConfig, ...(allConfigs[guildId] || {}) };
        }
    } catch (error) { 
        console.error('Error reading reports.json:', error); 
    }
    return { ...defaultGuildConfig };
}

function saveReportsConfig(guildId, guildConfig) {
    console.log(`[DEBUG] Attempting to save config for guild ${guildId}`);
    let allConfigs = {};
    try {
        if (fs.existsSync(reportsPath)) { 
            const fileContent = fs.readFileSync(reportsPath, 'utf8');
            const parsed = JSON.parse(fileContent);

            // حماية: التحقق من أن الملف بالصيغة الصحيحة (متعدد السيرفرات)
            // إذا كان الملف يحتوي على مفاتيح من الصيغة القديمة، نتجاهله ونبدأ من جديد
            if (parsed && typeof parsed === 'object') {
                if (parsed.enabled !== undefined && parsed.reportChannel !== undefined) {
                    // هذه صيغة قديمة! نتجاهلها ونبدأ من جديد
                    console.warn('[WARN] Detected old reports.json format, resetting to guild-based format');
                    allConfigs = {};
                } else {
                    allConfigs = parsed;
                }
            }
        }
    } catch (error) { 
        console.error('Error reading reports.json during save:', error); 
    }

    allConfigs[guildId] = guildConfig;

    try {
        // Ensure data directory exists
        const dataDir = path.dirname(reportsPath);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        fs.writeFileSync(reportsPath, JSON.stringify(allConfigs, null, 2));
        console.log(`[DEBUG] Successfully saved config for guild ${guildId} in correct format`);
        return true;
    } catch (error) {
        console.error(`[DEBUG] FAILED to save config for guild ${guildId}:`, error);
        return false;
    }
}

function createMainEmbed(client, guildId) {
    const config = loadReportsConfig(guildId);
    const status = config.enabled ? '**🟢 مفعل**' : '**🔴 معطل**';
    const pointsStatus = config.pointsOnReport ? 'بعد موافقة التقرير' : 'عند استلام المهمة';
    let channelStatus = 'لم يحدد';
    if (config.reportChannel) { 
        channelStatus = config.reportChannel === '0' ? 'خاص الأونرات' : `<#${config.reportChannel}>`; 
    }

    let approverStatus = 'الأونرات فقط';
    if (config.approverType === 'roles' && config.approverTargets && config.approverTargets.length > 0) {
        approverStatus = config.approverTargets.map(id => `<@&${id}>`).join(', ');
    } else if (config.approverType === 'responsibility' && config.approverTargets && config.approverTargets.length > 0) {
        approverStatus = `أعضاء: ${config.approverTargets.join(', ')}`;
    }

    return new EmbedBuilder()
        .setTitle('Report System')
        .setDescription('التحكم الكامل بإعدادات نظام التقارير والموافقة عليها.')
        .setColor(colorManager.getColor(client))
        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400661744682139690/download__1_-removebg-preview.png?ex=688d7366&is=688c21e6&hm=5635fe92ec3d4896d9ca065b9bb8ee11a5923b9e5d75fe94b753046e7e8b24eb&')
        .addFields(
            { name: 'حالة النظام', value: status, inline: true },
            { name: 'حالة النقاط', value: `*${pointsStatus}*`, inline: true },
            { name: 'روم التقارير', value: channelStatus, inline: true },
            { name: 'المعتمدون', value: approverStatus, inline: false }
        );
}

function createMainButtons(guildId) {
    const config = loadReportsConfig(guildId);
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('report_toggle_system')
            .setLabel(config.enabled ? 'تعطيل النظام' : 'تفعيل النظام')
            .setStyle(config.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('report_manage_resps')
            .setLabel('إدارة المسؤوليات')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('report_manage_templates')
            .setLabel('إدارة القوالب')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('report_advanced_settings')
            .setLabel('إعدادات متقدمة')
            .setStyle(ButtonStyle.Secondary)
    );
}

function createResponsibilitySelectMenu(responsibilities, customId, placeholder, currentPage = 0) {
    // التأكد من أن responsibilities كائن صحيح
    if (!responsibilities || typeof responsibilities !== 'object') {
        responsibilities = {};
    }

    const { createPaginatedResponsibilityMenu } = require('../utils/responsibilityPagination.js');
    return createPaginatedResponsibilityMenu(responsibilities, currentPage, customId, placeholder);
}

function createTemplateManagementEmbed(client, responsibilities, config) {
    const embed = new EmbedBuilder()
        .setTitle(' إدارة قوالب التقارير')
        .setDescription('إدارة القوالب المخصصة لكل مسؤولية')
        .setColor(colorManager.getColor(client))
        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400661744682139690/download__1_-removebg-preview.png?ex=688d7366&is=688c21e6&hm=5635fe92ec3d4896d9ca065b9bb8ee11a5923b9e5d75fe94b753046e7e8b24eb&');

    const templateCount = Object.keys(config.templates || {}).length;
    const totalResps = Object.keys(responsibilities).length;

    embed.addFields(
        { name: 'إجمالي المسؤوليات', value: totalResps.toString(), inline: true },
        { name: 'القوالب المحددة', value: templateCount.toString(), inline: true },
        { name: 'القوالب المفقودة', value: (totalResps - templateCount).toString(), inline: true }
    );

    return embed;
}

async function execute(message, args, { client, BOT_OWNERS }) {
        if (!BOT_OWNERS.includes(message.author.id)) return message.react('❌');

    try {
        await message.channel.send({ 
            embeds: [createMainEmbed(client, message.guild.id)], 
            components: [createMainButtons(message.guild.id)] 
        });
    } catch (error) {
        console.error('Error executing report command:', error);
        return message.reply('❌ حدث خطأ في تنفيذ الأمر.');
    }
}

async function handleInteraction(interaction, context) {
    const { client, scheduleSave, BOT_OWNERS, points } = context;
    const { customId, guildId } = interaction;

    console.log(`[Report] 🔔 معالجة تفاعل: ${customId} من المستخدم: ${interaction.user.id}`);
    console.log(`[Report] نوع التفاعل: ${interaction.isButton() ? 'Button' : interaction.isStringSelectMenu() ? 'SelectMenu' : interaction.isModalSubmit() ? 'Modal' : interaction.isChannelSelectMenu() ? 'ChannelSelect' : interaction.isRoleSelectMenu() ? 'RoleSelect' : 'Unknown'}`);

    try {
        // إعادة تحميل المسؤوليات من الملف مباشرة
        const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
        let responsibilities = {};
        try {
            if (fs.existsSync(responsibilitiesPath)) {
                const data = fs.readFileSync(responsibilitiesPath, 'utf8');
                responsibilities = JSON.parse(data);
                console.log(`[Report] تم تحميل ${Object.keys(responsibilities).length} مسؤولية:`, Object.keys(responsibilities));
            } else {
                console.log('[Report] ⚠️ ملف المسؤوليات غير موجود');
            }
        } catch (error) {
            console.error('❌ خطأ في قراءة المسؤوليات:', error);
        }

        // Check if interaction is from submission or approval/reject buttons
        const isSubmission = customId.startsWith('report_write_') || 
                           customId.startsWith('report_submit_') || 
                           customId.startsWith('report_edit_');

        const isApprovalAction = customId.startsWith('report_approve_') || 
                                customId.startsWith('report_reject_');

        // تحميل BOT_OWNERS من السياق أو من الملف مباشرة
        const botOwnersToCheck = BOT_OWNERS || context.BOT_OWNERS || [];

        // التحقق من صلاحيات الأزرار العادية (غير الموافقة/الرفض)
        // يجب أن يكون المستخدم هو نفسه الذي استخدم الأمر الأساسي
        if (!isSubmission && !isApprovalAction) {
            // التحقق من أن المستخدم هو صاحب الرسالة الأصلية
            if (interaction.message && interaction.message.interaction) {
                const originalUserId = interaction.message.interaction.user.id;
                if (interaction.user.id !== originalUserId) {
                    console.log(`❌ المستخدم ${interaction.user.id} ليس صاحب الأمر الأصلي`);
                    if (!interaction.replied && !interaction.deferred) {
                        return await interaction.reply({ 
                            content: '❌ فقط الشخص الذي استخدم الأمر يمكنه التحكم به!', 
                            ephemeral: true 
                        });
                    }
                    return;
                }
            }
        }

        console.log(`✅ تم التحقق من صلاحيات المستخدم ${interaction.user.id}`);

        let config = loadReportsConfig(guildId);

        // Handle modal submissions
        if (interaction.isModalSubmit()) {
            if (customId.startsWith('report_template_save_modal_')) {
                await interaction.deferReply({ ephemeral: true });
                const respName = customId.replace('report_template_save_modal_', '');
                const templateText = interaction.fields.getTextInputValue('template_text');

                if (templateText.trim()) { 
                    config.templates[respName] = templateText.trim(); 
                } else { 
                    delete config.templates[respName]; 
                }

                if (saveReportsConfig(guildId, config)) {
                    await interaction.editReply({ 
                        content: `✅ تم حفظ القالب للمسؤولية: ${respName}` 
                    });
                } else {
                    await interaction.editReply({ 
                        content: '❌ فشل في حفظ القالب.' 
                    });
                }
                return;
            }

            if (customId === 'report_template_apply_all_modal') {
                await interaction.deferReply({ ephemeral: true });
                const templateText = interaction.fields.getTextInputValue('template_text_all');

                for (const respName in responsibilities) { 
                    config.templates[respName] = templateText.trim(); 
                }

                if (saveReportsConfig(guildId, config)) {
                    await interaction.editReply({ 
                        content: `✅ تم تطبيق القالب بنجاح على جميع المسؤوليات.` 
                    });
                } else {
                    await interaction.editReply({ 
                        content: '❌ فشل في تطبيق القالب.' 
                    });
                }
                return;
            }

            // Handle clarification question modal
            if (customId.startsWith('report_clarification_question_')) {
                await interaction.deferReply({ ephemeral: true });
                const reportId = customId.replace('report_clarification_question_', '');
                const reportData = client.pendingReports?.get(reportId);

                if (!reportData) {
                    return await interaction.editReply({ 
                        content: '❌ لم يتم العثور على هذا التقرير.' 
                    });
                }

                const clarificationQuestion = interaction.fields.getTextInputValue('clarification_question');

                // Save clarification data
                if (!reportData.clarifications) {
                    reportData.clarifications = [];
                }

                reportData.clarifications.push({
                    question: clarificationQuestion,
                    askedBy: interaction.user.id,
                    askedAt: Date.now(),
                    answer: null,
                    answeredAt: null
                });

                // تعطيل زر طلب التوضيح
                reportData.hasActiveClarificationButton = false;

                client.pendingReports.set(reportId, reportData);
                scheduleSave();

                // Send DM to the reporter
                try {
                    const reporter = await client.users.fetch(reportData.claimerId);
                    const clarificationEmbed = new EmbedBuilder()
                        .setTitle('Clarification Request')
                        .setDescription(`تم طلب توضيح على تقريرك للمسؤولية : **${reportData.responsibilityName}**`)
                        .setColor('#ffffff')
                        .addFields([
                            { name: '<:emoji_31:1430330925304250591> السؤال', value: clarificationQuestion, inline: false },
                            { name: '<:emoji_32:1430330951342358692> من قِبل', value: `<@${interaction.user.id}>`, inline: true },
                            { name: '<:emoji_37:1430331094569455746> تقريرك الأصلي', value: reportData.reportText ? (reportData.reportText.length > 500 ? reportData.reportText.substring(0, 497) + '...' : reportData.reportText) : 'غير متوفر', inline: false }
                        ])
                        .setFooter({ text: `سيتم اعلامك بحالة الموافقه بعد  قليل` })
                        .setTimestamp();

                    const answerButton = new ButtonBuilder()
                        .setCustomId(`report_answer_clarification_${reportId}`)
                        .setLabel('إضافة توضيح')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('<:emoji_35:1430331052773081181>');

                    await reporter.send({ 
                        embeds: [clarificationEmbed], 
                        components: [new ActionRowBuilder().addComponents(answerButton)] 
                    });

                    await interaction.editReply({ 
                        content: '✅ Sended' 
                    });

                    // Update original report message with disabled button
                    try {
                        const originalEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
                        originalEmbed.addFields([
                            { 
                                name: '<:emoji_35:1430331052773081181> طلب توضيح', 
                                value: `بواسطة <@${interaction.user.id}>\n${clarificationQuestion}`, 
                                inline: false 
                            }
                        ]);

                        // تحديث الأزرار مع تعطيل زر طلب التوضيح
                        const approveButton = new ButtonBuilder()
                            .setCustomId(`report_approve_${reportId}`)
                            .setLabel('قبول التقرير')
                            .setStyle(ButtonStyle.Success)
                            .setEmoji('<:emoji_41:1430334120839479449>');

                        const rejectButton = new ButtonBuilder()
                            .setCustomId(`report_reject_${reportId}`)
                            .setLabel('رفض التقرير')
                            .setStyle(ButtonStyle.Danger)
                            .setEmoji('<:emoji_39:1430334088924893275>');

                        const askClarificationButton = new ButtonBuilder()
                            .setCustomId(`report_ask_clarification_${reportId}_disabled`)
                            .setLabel('تم طلب التوضيح')
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('✔️')
                            .setDisabled(true);

                        await interaction.message.edit({ 
                            embeds: [originalEmbed],
                            components: [new ActionRowBuilder().addComponents(approveButton, rejectButton, askClarificationButton)]
                        });
                    } catch (err) {
                        console.error('Failed to update report message:', err);
                    }
                } catch (error) {
                    console.error('Failed to send clarification request:', error);
                    await interaction.editReply({ 
                        content: '❌ فشل في إرسال طلب التوضيح للمُبلّغ. تأكد من أن الرسائل الخاصة مفتوحة.' 
                    });
                }
                return;
            }

            // Handle clarification answer modal
            if (customId.startsWith('report_answer_clarification_modal_')) {
                await interaction.deferReply({ ephemeral: true });
                const reportId = customId.replace('report_answer_clarification_modal_', '');
                const reportData = client.pendingReports?.get(reportId);

                if (!reportData) {
                    return await interaction.editReply({ 
                        content: '❌ لم يتم العثور على هذا التقرير.' 
                    });
                }

                const clarificationAnswer = interaction.fields.getTextInputValue('clarification_answer');

                // Find the latest unanswered clarification
                if (reportData.clarifications && reportData.clarifications.length > 0) {
                    const latestClarification = reportData.clarifications[reportData.clarifications.length - 1];
                    if (!latestClarification.answer) {
                        latestClarification.answer = clarificationAnswer;
                        latestClarification.answeredAt = Date.now();
                        latestClarification.answeredBy = interaction.user.id;
                        client.pendingReports.set(reportId, reportData);
                        scheduleSave();

                        // تحديث رسالة الطلب الأصلية بإيمبد النجاح وتعطيل الأزرار
                        try {
                            const originalMessage = await interaction.message.fetch();
                            const successEmbed = new EmbedBuilder()
                                .setDescription('✅ **Done sended**')
                                .setColor('#00ff00')
                                .setTimestamp();

                            await originalMessage.edit({ 
                                embeds: [successEmbed],
                                components: []
                            });
                        } catch (err) {
                            console.error('Failed to update original message:', err);
                        }

                        await interaction.editReply({ 
                            content: '✅ ' 
                        });

                        // إرسال إشعار للمسؤول الذي طلب التوضيح
                        try {
                            const requester = await client.users.fetch(latestClarification.askedBy);
                            const notificationEmbed = new EmbedBuilder()
                                .setTitle('✅ Reply from Resp')
                                .setDescription(`تم الرد على طلبك للتوضيح للمسؤولية : **${reportData.responsibilityName}**`)
                                .setColor('#ffffff')
                                .addFields([
                                    { name: '<:emoji_31:1430330925304250591> سؤالك', value: latestClarification.question, inline: false },
                                    { name: '<:emoji_35:1430331052773081181> الرد', value: clarificationAnswer, inline: false },
                                    { name: '<:emoji_32:1430330978580041838> من قِبل', value: `<@${interaction.user.id}>`, inline: true }
                                ])
                                .setFooter({ text: `معرف التقرير : ${reportId}` })
                                .setTimestamp();

                            await requester.send({ embeds: [notificationEmbed] });
                        } catch (err) {
                            console.error('Failed to send notification to requester:', err);
                        }

                        // Update the report in the channel with the clarification
                        try {
                            const reportGuildId = reportData.guildId || guildId;
                            const guildConfig = loadReportsConfig(reportGuildId);

                            if (guildConfig.reportChannel && guildConfig.reportChannel !== '0') {
                                const reportChannel = await client.channels.fetch(guildConfig.reportChannel);
                                const messages = await reportChannel.messages.fetch({ limit: 50 });
                                const reportMessage = messages.find(msg => 
                                    msg.embeds.length > 0 && 
                                    msg.embeds[0].footer && 
                                    msg.embeds[0].footer.text && 
                                    msg.embeds[0].footer.text.includes(reportId)
                                );

                                if (reportMessage) {
                                    const updatedEmbed = EmbedBuilder.from(reportMessage.embeds[0]);
                                    updatedEmbed.addFields([
                                        { 
                                            name: '<:emoji_21:1429266842345672746> التوضيح المضاف', 
                                            value: clarificationAnswer, 
                                            inline: false 
                                        },
                                        { 
                                            name: '<:emoji_34:1430331032405544970> تاريخ التوضيح', 
                                            value: `<t:${Math.floor(Date.now() / 1000)}:R>`, 
                                            inline: true 
                                        }
                                    ]);

                                    // الحفاظ على الأزرار الحالية بدون تغيير
                                    await reportMessage.edit({ embeds: [updatedEmbed] });
                                }
                            }
                        } catch (err) {
                            console.error('Failed to update report with clarification:', err);
                        }
                    } else {
                        await interaction.editReply({ 
                            content: '❌ تم الرد على هذا الطلب مسبقاً.' 
                        });
                    }
                } else {
                    await interaction.editReply({ 
                        content: '❌ لا يوجد طلب توضيح لهذا التقرير.' 
                    });
                }
                return;
            }

            // Handle report writing modal
            if (customId.startsWith('report_submit_')) {
                const reportId = customId.replace('report_submit_', '');
                const reportData = client.pendingReports?.get(reportId);

                if (!reportData) {
                    return await interaction.reply({ 
                        content: '❌ **لم يتم العثور على هذا التقرير أو انتهت صلاحيته.**',
                        ephemeral: true
                    });
                }

                // التحقق من أن التقرير لم يتم إرساله من قبل
                if (reportData.submitted) {
                    return await interaction.reply({ 
                        content: '❌ **تم إرسال هذا التقرير مسبقاً!**',
                        ephemeral: true
                    });
                }

                const reportText = interaction.fields.getTextInputValue('report_text');

                // Mark as submitted IMMEDIATELY to prevent double submission
                reportData.submitted = true;
                reportData.reportText = reportText;
                reportData.submittedAt = Date.now();
                client.pendingReports.set(reportId, reportData);

                // الحصول على الإعدادات الصحيحة بناءً على معرف السيرفر
                const reportGuildId = reportData.guildId || interaction.guildId;
                const guildConfig = loadReportsConfig(reportGuildId);

                // Check if approval is required (نقل التعريف قبل الاستخدام)
                const isApprovalRequired = guildConfig.approvalRequiredFor && 
                                          Array.isArray(guildConfig.approvalRequiredFor) && 
                                          guildConfig.approvalRequiredFor.includes(reportData.responsibilityName);

                // Create report embed with link to original message
                const currentTimestamp = Math.floor(Date.now() / 1000);
                const reportEmbed = new EmbedBuilder()
                    .setTitle('New Report')
                    .setDescription(`**المسؤولية:** ${reportData.responsibilityName}`)
                    .setColor('#ffffff')
                    .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                    .addFields([
                        { 
                            name: '<:emoji_32:1430330978580041838> المسؤول', 
                            value: `<@${reportData.claimerId}>\n${reportData.displayName}`, 
                            inline: true 
                        },
                        { 
                            name: '<:emoji_34:1430331032405544970> التاريخ', 
                            value: `<t:${currentTimestamp}:D>`, 
                            inline: true 
                        },
                        { 
                            name: '<:emoji_33:1430331008514916422> الوقت', 
                            value: `<t:${currentTimestamp}:t>`, 
                            inline: true 
                        }
                    ]);

                // إضافة صاحب الطلب (الإداري) إذا كان موجوداً
                if (reportData.requesterId) {
                    reportEmbed.addFields([
                        { 
                            name: '<:emoji_32:1430330951342358692> الاداري الذي طلب', 
                            value: `<@${reportData.requesterId}>`, 
                            inline: true 
                        }
                    ]);
                }

                // إضافة السبب
                reportEmbed.addFields([
                    { 
                        name: '<:emoji_35:1430331052773081181> السبب', 
                        value: reportData.reason || 'لا يوجد', 
                        inline: false 
                    }
                ]);

                // إضافة رابط الرسالة الأصلية إذا كان متوفراً
                if (reportData.originalMessageId && reportData.originalChannelId && reportData.originalMessageId !== 'unknown' && reportGuildId) {
                    const messageUrl = `https://discord.com/channels/${reportGuildId}/${reportData.originalChannelId}/${reportData.originalMessageId}`;
                    reportEmbed.addFields([
                        { 
                            name: '<:emoji_30:1430329732951707770> المصدر', 
                            value: `[Message](${messageUrl})`, 
                            inline: false 
                        }
                    ]);
                }

                // إضافة التقرير
                const truncatedReport = reportText.length > 1024 ? reportText.substring(0, 1021) + '...' : reportText;
                reportEmbed.addFields([
                    { 
                        name: '<:emoji_37:1430331094569455746> التقرير', 
                        value: truncatedReport, 
                        inline: false 
                    }
                ]);

                // إضافة Footer و Timestamp
                reportEmbed
                    .setTimestamp()
                    .setFooter({ 
                        text: `Status : On `,
                        iconURL: client.user.displayAvatarURL()
                    });

                // Create approval buttons if needed
                let components = [];
                if (isApprovalRequired) {
                    const approveButton = new ButtonBuilder()
                        .setCustomId(`report_approve_${reportId}`)
                        .setLabel('قبول التقرير')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('<:emoji_42:1430334150057001042>');

                    const rejectButton = new ButtonBuilder()
                        .setCustomId(`report_reject_${reportId}`)
                        .setLabel('رفض التقرير')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('<:emoji_44:1430334506371645593>');

                    const askClarificationButton = new ButtonBuilder()
                        .setCustomId(`report_ask_clarification_${reportId}`)
                        .setLabel('طلب توضيح')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('<:emoji_31:1430330925304250591>');

                    // حفظ مرجع للأزرار في reportData
                    reportData.hasActiveClarificationButton = true;

                    components = [new ActionRowBuilder().addComponents(approveButton, rejectButton, askClarificationButton)];
                }

                // Send report to channel or DMs
                try {
                    if (guildConfig.reportChannel === '0') {
                        // Send to bot owners via DM
                        for (const ownerId of BOT_OWNERS) {
                            try {
                                const owner = await client.users.fetch(ownerId);
                                await owner.send({ 
                                    embeds: [reportEmbed], 
                                    components: components 
                                });
                            } catch (err) {
                                console.error(`Failed to send report to owner ${ownerId}:`, err);
                            }
                        }

                        // Mark as submitted only after successful send
                        reportData.submitted = true;
                        client.pendingReports.set(reportId, reportData);

                        // تحديث الرسالة الأصلية بإيمبد النجاح وتعطيل الأزرار
                        const successEmbed = new EmbedBuilder()
                            .setDescription('**Done Sended ✅️**')
                            .setColor('#ffffff')
                            .setTimestamp();

                        await interaction.update({ 
                            embeds: [successEmbed],
                            components: []
                        });
                    } else if (guildConfig.reportChannel) {
                        // Send to specific channel
                        const reportChannel = await client.channels.fetch(guildConfig.reportChannel);
                        await reportChannel.send({ 
                            embeds: [reportEmbed], 
                            components: components 
                        });

                        // Mark as submitted only after successful send
                        reportData.submitted = true;
                        client.pendingReports.set(reportId, reportData);

                        // تحديث الرسالة الأصلية بإيمبد النجاح وتعطيل الأزرار
                        const successEmbed = new EmbedBuilder()
                            .setDescription('✅ ** Done!**')
                            .setColor('#00ff00')
                            .setTimestamp();

                        await interaction.update({ 
                            embeds: [successEmbed],
                            components: []
                        });
                    } else {
                        const errorEmbed = new EmbedBuilder()
                            .setDescription('❌ **لم يتم تحديد روم التقارير!**')
                            .setColor('#ff0000');

                        await interaction.update({ 
                            embeds: [errorEmbed],
                            components: []
                        });
                        return;
                    }

                    // If no approval required
                    if (!isApprovalRequired) {
                        // Award points if pointsOnReport is true
                        if (config.pointsOnReport) {
                            const { claimerId, responsibilityName, timestamp } = reportData;
                            if (!points[responsibilityName]) points[responsibilityName] = {};
                            if (!points[responsibilityName][claimerId]) points[responsibilityName][claimerId] = {};
                            if (typeof points[responsibilityName][claimerId] === 'number') {
                                const oldPoints = points[responsibilityName][claimerId];
                                points[responsibilityName][claimerId] = {
                                    [Date.now() - (35 * 24 * 60 * 60 * 1000)]: oldPoints
                                };
                            }
                            if (!points[responsibilityName][claimerId][timestamp]) {
                                points[responsibilityName][claimerId][timestamp] = 0;
                            }
                            points[responsibilityName][claimerId][timestamp] += 1;
                            scheduleSave();
                        }

                        // Always remove from pending reports when no approval is required
                        client.pendingReports.delete(reportId);
                        scheduleSave();
                    }

                } catch (error) {
                    console.error('Error sending report:', error);
                    // Don't mark as submitted if sending failed, so user can retry
                    if (!interaction.replied) {
                        await interaction.reply({ 
                            content: '❌ **حدث خطأ في إرسال التقرير! يرجى المحاولة مرة أخرى.**',
                            ephemeral: true
                        });
                    }
                }
                return;
            }
        }

        // Handle report writing button (special case - shows modal)
        if (customId.startsWith('report_write_')) {
            const reportId = customId.replace('report_write_', '');
            const reportData = client.pendingReports?.get(reportId);

            if (!reportData) {
                const errorEmbed = new EmbedBuilder()
                    .setDescription('❌ **لم يتم العثور على هذا التقرير أو انتهت صلاحيته.**')
                    .setColor('#FF0000');

                return await interaction.update({ 
                    embeds: [errorEmbed],
                    components: []
                }).catch(() => {});
            }

            // التحقق من أن التقرير لم يتم إرساله من قبل
            if (reportData.submitted) {
                const errorEmbed = new EmbedBuilder()
                    .setDescription('✅ **تم إرسال هذا التقرير مسبقاً!**')
                    .setColor('#00ff00');

                return await interaction.update({ 
                    embeds: [errorEmbed],
                    components: []
                }).catch(() => {});
            }

            // إعادة تحميل المسؤوليات للتأكد من وجودها
            let currentResponsibilities = {};
            try {
                if (fs.existsSync(responsibilitiesPath)) {
                    const data = fs.readFileSync(responsibilitiesPath, 'utf8');
                    currentResponsibilities = JSON.parse(data);
                }
            } catch (error) {
                console.error('❌ خطأ في قراءة المسؤوليات:', error);
            }

            // التحقق من وجود المسؤولية
            if (!currentResponsibilities[reportData.responsibilityName]) {
                const errorEmbed = new EmbedBuilder()
                    .setDescription(`❌ **المسؤولية "${reportData.responsibilityName}" لم تعد موجودة!**`)
                    .setColor('#FF0000');

                return await interaction.update({ 
                    embeds: [errorEmbed],
                    components: []
                }).catch(() => {});
            }

            const modal = new ModalBuilder()
                .setCustomId(`report_submit_${reportId}`)
                .setTitle('Report');

            // الحصول على الإعدادات الصحيحة بناءً على معرف السيرفر
            const reportGuildId = reportData.guildId || interaction.guildId;
            const guildConfig = loadReportsConfig(reportGuildId);

            const template = guildConfig.templates?.[reportData.responsibilityName] || '';
            const reportInput = new TextInputBuilder()
                .setCustomId('report_text')
                .setLabel('الرجاء كتابة تقريرك هنا')
                
                .setStyle(TextInputStyle.Paragraph)
                .setValue(template)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(reportInput));

            try {
                await interaction.showModal(modal);
            } catch (error) {
                console.error('Error showing modal:', error);
                const errorEmbed = new EmbedBuilder()
                    .setDescription('❌ **حدث خطأ في عرض نموذج التقرير.**')
                    .setColor('#FF0000');

                if (!interaction.replied && !interaction.deferred) {
                    await interaction.update({ 
                        embeds: [errorEmbed],
                        components: []
                    }).catch(() => {});
                }
            }
            return;
        }

        // Handle answer clarification button
        if (customId.startsWith('report_answer_clarification_')) {
            const reportId = customId.replace('report_answer_clarification_', '');
            const reportData = client.pendingReports?.get(reportId);

            if (!reportData) {
                return await interaction.reply({ 
                    content: 'لم يتم العثور على هذا التقرير أو انتهت صلاحيته.', 
                    ephemeral: true 
                });
            }

            // التحقق من أن التوضيح لم يتم إرساله من قبل
            if (reportData.clarifications && reportData.clarifications.length > 0) {
                const latestClarification = reportData.clarifications[reportData.clarifications.length - 1];
                if (latestClarification.answer) {
                    return await interaction.reply({ 
                        content: '✅ تم إرسال التوضيح مسبقاً!', 
                        ephemeral: true 
                    });
                }
            }

            // Show modal to answer the clarification
            const answerModal = new ModalBuilder()
                .setCustomId(`report_answer_clarification_modal_${reportId}`)
                .setTitle('إضافة توضيح');

            const answerInput = new TextInputBuilder()
                .setCustomId('clarification_answer')
                .setLabel('أضف التوضيح المطلوب')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('اكتب التوضيح هنا...')
                .setRequired(true);

            answerModal.addComponents(new ActionRowBuilder().addComponents(answerInput));

            try {
                await interaction.showModal(answerModal);
            } catch (error) {
                console.error('Error showing answer modal:', error);
                await interaction.reply({ 
                    content: '❌ حدث خطأ في عرض نموذج التوضيح.', 
                    ephemeral: true 
                }).catch(() => {});
            }
            return;
        }

        // Handle all other interactions
        try {
            // قائمة التفاعلات التي لا تحتاج لـ defer مطلقاً
            const noDefer = customId === 'report_template_apply_all_btn' || 
                          customId === 'report_template_edit_select' ||
                          customId === 'report_template_select_resp' ||
                          customId.startsWith('report_write_') ||
                          customId.startsWith('report_submit_') ||
                          customId.startsWith('report_ask_clarification_');

            // defer فقط للتفاعلات التي تحتاجه
            if (!noDefer && (interaction.isButton() || interaction.isStringSelectMenu() || 
                interaction.isChannelSelectMenu() || interaction.isRoleSelectMenu()) && 
                !interaction.replied && !interaction.deferred) {
                await interaction.deferUpdate();
            }
        } catch (error) {
            // تجاهل الأخطاء المعروفة بصمت
            const ignoredErrorCodes = [10008, 40060, 10062, 10003];
            if (error.code && ignoredErrorCodes.includes(error.code)) {
                return;
            }
            console.error('❌ خطأ في تأجيل التفاعل:', error);
            return;
        }

        if (interaction.isButton()) {
            let shouldShowMain = false;
            let shouldSave = false;
            let responseContent = '';
            let newComponents = null;

            switch (customId) {
                case 'report_toggle_system':
                    config.enabled = !config.enabled;
                    shouldShowMain = true;
                    shouldSave = true;
                    responseContent = config.enabled ? '✅ تم تفعيل نظام التقارير.' : '✅ تم تعطيل نظام التقارير.';
                    break;

                case 'report_back_to_main':
                    shouldShowMain = true;
                    break;

                case 'report_set_dms_button':
                    config.reportChannel = '0';
                    shouldShowMain = true;
                    shouldSave = true;
                    responseContent = '✅ سيتم الآن إرسال التقارير إلى خاص الأونرات.';
                    break;

                case 'report_toggle_points':
                    config.pointsOnReport = !config.pointsOnReport;
                    shouldShowMain = true;
                    shouldSave = true;
                    responseContent = `✅ تم تغيير نظام النقاط إلى: ${config.pointsOnReport ? 'بعد موافقة التقرير' : 'عند استلام المهمة'}.`;
                    break;

                case 'report_template_delete_all':
                    config.templates = {};
                    shouldSave = true;
                    responseContent = '✅ تم حذف جميع القوالب بنجاح.';
                    break;

                case 'report_template_apply_default':
                    const defaultTemplate = `**- ملخص الإنجاز:**\n\n\n**- هل تمت مواجهة مشاكل؟:**\n\n\n**- ملاحظات إضافية:**`;
                    for (const respName in responsibilities) { 
                        config.templates[respName] = defaultTemplate; 
                    }
                    shouldSave = true;
                    responseContent = '✅ تم تطبيق القالب الافتراضي بنجاح.';
                    break;

                case 'report_manage_resps':
                    // إنشاء embed منظم يعرض حالة المسؤوليات
                    const respsEmbed = colorManager.createEmbed()
                        .setTitle('Res settings')
                        .setDescription('** Res status:**')
                        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400661744682139690/download__1_-removebg-preview.png?ex=688d7366&is=688c21e6&hm=5635fe92ec3d4896d9ca065b9bb8ee11a5923b9e5d75fe94b753046e7e8b24eb&')
                        .setTimestamp();

                    const requiredReport = config.requiredFor || [];
                    const requiredApproval = config.approvalRequiredFor || [];

                    // تصنيف المسؤوليات
                    const both = [];
                    const reportOnly = [];
                    const approvalOnly = [];
                    const neither = [];

                    for (const respName of Object.keys(responsibilities)) {
                        const hasReport = requiredReport.includes(respName);
                        const hasApproval = requiredApproval.includes(respName);

                        if (hasReport && hasApproval) {
                            both.push(respName);
                        } else if (hasReport) {
                            reportOnly.push(respName);
                        } else if (hasApproval) {
                            approvalOnly.push(respName);
                        } else {
                            neither.push(respName);
                        }
                    }

                    // إضافة الحقول
                    if (both.length > 0) {
                        respsEmbed.addFields([
                            { 
                                name: '✅ **إلزامية التقرير والموافقة**', 
                                value: both.map(r => `• ${r}`).join('\n'), 
                                inline: false 
                            }
                        ]);
                    }

                    if (reportOnly.length > 0) {
                        respsEmbed.addFields([
                            { 
                                name: ' **إلزامية التقرير فقط**', 
                                value: reportOnly.map(r => `• ${r}`).join('\n'), 
                                inline: false 
                            }
                        ]);
                    }

                    if (approvalOnly.length > 0) {
                        respsEmbed.addFields([
                            { 
                                name: '✔️ **إلزامية الموافقة فقط**', 
                                value: approvalOnly.map(r => `• ${r}`).join('\n'), 
                                inline: false 
                            }
                        ]);
                    }

                    if (neither.length > 0) {
                        respsEmbed.addFields([
                            { 
                                name: ' **بدون إلزامية**', 
                                value: neither.map(r => `• ${r}`).join('\n'), 
                                inline: false 
                            }
                        ]);
                    }

                    if (Object.keys(responsibilities).length === 0) {
                        respsEmbed.addFields([
                            { name: '⚠️ لا توجد مسؤوليات', value: 'يجب إنشاء مسؤوليات أولاً', inline: false }
                        ]);
                    }

                    await interaction.editReply({
                        content: '',
                        embeds: [respsEmbed],
                        components: [
                            new ActionRowBuilder().addComponents(
                                new ButtonBuilder()
                                    .setCustomId('report_select_req_report')
                                    .setLabel('تحديد إلزامية التقرير')
                                    .setStyle(ButtonStyle.Primary),
                                new ButtonBuilder()
                                    .setCustomId('report_select_req_approval')
                                    .setLabel('تحديد إلزامية الموافقة')
                                    .setStyle(ButtonStyle.Primary)
                            ),
                            new ActionRowBuilder().addComponents(
                                new ButtonBuilder()
                                    .setCustomId('report_back_to_main')
                                    .setLabel('➡️ العودة')
                                    .setStyle(ButtonStyle.Secondary)
                            )
                        ]
                    });
                    return;

                case 'report_select_req_report':
                    // إعادة تحميل المسؤوليات للتأكد من أحدث البيانات
                    let reqReportResps = {};
                    try {
                        if (fs.existsSync(responsibilitiesPath)) {
                            const data = fs.readFileSync(responsibilitiesPath, 'utf8');
                            reqReportResps = JSON.parse(data);
                        }
                    } catch (error) {
                        console.error('[Report] ❌ خطأ في قراءة المسؤوليات:', error);
                    }

                    const reportOptions = Object.keys(reqReportResps).slice(0, 25).map(respName => ({
                        label: respName,
                        value: respName,
                        description: config.requiredFor?.includes(respName) ? '✅ مفعل حالياً' : 'غير مفعل',
                        default: config.requiredFor?.includes(respName) || false
                    }));

                    if (reportOptions.length === 0) {
                        reportOptions.push({
                            label: 'لا توجد مسؤوليات',
                            value: 'none',
                            description: 'يجب إنشاء مسؤوليات أولاً'
                        });
                    }

                    const reportSelectMenu = new StringSelectMenuBuilder()
                        .setCustomId('report_confirm_req_report')
                        .setPlaceholder('اختر المسؤوليات المطلوب تقرير لها...')
                        .setMinValues(0)
                        .setMaxValues(Math.min(reportOptions.length, 25))
                        .addOptions(reportOptions);

                    responseContent = ' **اختر المسؤوليات التي تتطلب تقرير:**';
                    newComponents = [
                        new ActionRowBuilder().addComponents(reportSelectMenu),
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('report_manage_resps')
                                .setLabel('➡️ العودة')
                                .setStyle(ButtonStyle.Secondary)
                        )
                    ];
                    break;

                case 'report_select_req_approval':
                    // إعادة تحميل المسؤوليات للتأكد من أحدث البيانات
                    let reqApprovalResps = {};
                    try {
                        if (fs.existsSync(responsibilitiesPath)) {
                            const data = fs.readFileSync(responsibilitiesPath, 'utf8');
                            reqApprovalResps = JSON.parse(data);
                        }
                    } catch (error) {
                        console.error('[Report] ❌ خطأ في قراءة المسؤوليات:', error);
                    }

                    const approvalOptions = Object.keys(reqApprovalResps).slice(0, 25).map(respName => ({
                        label: respName,
                        value: respName,
                        description: config.approvalRequiredFor?.includes(respName) ? '✅ مفعل حالياً' : 'غير مفعل',
                        default: config.approvalRequiredFor?.includes(respName) || false
                    }));

                    if (approvalOptions.length === 0) {
                        approvalOptions.push({
                            label: 'لا توجد مسؤوليات',
                            value: 'none',
                            description: 'يجب إنشاء مسؤوليات أولاً'
                        });
                    }

                    const approvalSelectMenu = new StringSelectMenuBuilder()
                        .setCustomId('report_confirm_req_approval')
                        .setPlaceholder('اختر المسؤوليات المطلوب موافقة تقريرها...')
                        .setMinValues(0)
                        .setMaxValues(Math.min(approvalOptions.length, 25))
                        .addOptions(approvalOptions);

                    responseContent = '✔️ **اختر المسؤوليات التي تتطلب موافقة على التقرير من مسؤول المسؤوليات :**\n';
                    newComponents = [
                        new ActionRowBuilder().addComponents(approvalSelectMenu),
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('report_manage_resps')
                                .setLabel('➡️ العودة')
                                .setStyle(ButtonStyle.Secondary)
                        )
                    ];
                    break;

                case 'report_manage_templates':
                    responseContent = 'إدارة قوالب التقارير:';
                    newComponents = [
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('report_template_select_resp')
                                .setLabel('تعديل قالب مسؤولية')
                                .setStyle(ButtonStyle.Primary),
                            new ButtonBuilder()
                                .setCustomId('report_template_apply_all_btn')
                                .setLabel('تطبيق قالب على الكل')
                                .setStyle(ButtonStyle.Primary),
                            new ButtonBuilder()
                                .setCustomId('report_template_apply_default')
                                .setLabel('القالب الافتراضي')
                                .setStyle(ButtonStyle.Success)
                        ),
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('report_view_templates')
                                .setLabel('رؤية القوالب الحالية')
                                .setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder()
                                .setCustomId('report_template_delete_all')
                                .setLabel('حذف جميع القوالب')
                                .setStyle(ButtonStyle.Danger),
                            new ButtonBuilder()
                                .setCustomId('report_back_to_main')
                                .setLabel('➡️ العودة')
                                .setStyle(ButtonStyle.Secondary)
                        )
                    ];
                    break;

                case 'report_view_templates':
                    // عرض القوالب الحالية
                    const templatesEmbed = colorManager.createEmbed()
                        .setTitle('Templates')
                        .setDescription('قوالب التقارير المحددة لكل مسؤولية')
                        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400661744682139690/download__1_-removebg-preview.png?ex=688d7366&is=688c21e6&hm=5635fe92ec3d4896d9ca065b9bb8ee11a5923b9e5d75fe94b753046e7e8b24eb&')
                        .setTimestamp();

                    if (Object.keys(config.templates || {}).length === 0) {
                        templatesEmbed.addFields([
                            { name: '⚠️ لا توجد قوالب', value: 'لم يتم تحديد أي قوالب بعد.', inline: false }
                        ]);
                    } else {
                        for (const [respName, template] of Object.entries(config.templates)) {
                            const truncatedTemplate = template.length > 150 ? template.substring(0, 150) + '...' : template;
                            templatesEmbed.addFields([
                                { name: `📌 ${respName}`, value: truncatedTemplate || 'قالب فارغ', inline: false }
                            ]);
                        }
                    }

                    await interaction.editReply({
                        content: '',
                        embeds: [templatesEmbed],
                        components: [
                            new ActionRowBuilder().addComponents(
                                new ButtonBuilder()
                                    .setCustomId('report_manage_templates')
                                    .setLabel('➡️ العودة')
                                    .setStyle(ButtonStyle.Secondary)
                            )
                        ]
                    });
                    return;

                case 'report_template_select_resp':
                    // إعادة تحميل المسؤوليات من الملف للتأكد من أحدث البيانات
                    let latestResponsibilities = {};
                    try {
                        if (fs.existsSync(responsibilitiesPath)) {
                            const data = fs.readFileSync(responsibilitiesPath, 'utf8');
                            latestResponsibilities = JSON.parse(data);
                        }
                    } catch (error) {
                        console.error('[Report] ❌ خطأ في قراءة المسؤوليات:', error);
                    }

                    responseContent = 'اختر المسؤولية لتعديل قالبها:';
                    const pagination = createResponsibilitySelectMenu(
                        latestResponsibilities, 
                        'report_template_edit_select', 
                        'اختر المسؤولية لتعديل قالبها'
                    );
                    newComponents = [
                        ...pagination.components,
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('report_manage_templates')
                                .setLabel('➡️ العودة')
                                .setStyle(ButtonStyle.Secondary)
                        )
                    ];
                    break;

                case 'report_template_apply_all_btn':
                    const applyAllModal = new ModalBuilder()
                        .setCustomId('report_template_apply_all_modal')
                        .setTitle('تطبيق قالب على جميع المسؤوليات');

                    const allTemplateInput = new TextInputBuilder()
                        .setCustomId('template_text_all')
                        .setLabel('القالب الجديد')
                        .setStyle(TextInputStyle.Paragraph)
                        .setPlaceholder('اكتب القالب الذي تريد تطبيقه على جميع المسؤوليات...')
                        .setRequired(true);

                    applyAllModal.addComponents(new ActionRowBuilder().addComponents(allTemplateInput));

                    try {
                        await interaction.showModal(applyAllModal);
                    } catch (error) {
                        console.error('Error showing apply all modal:', error);
                        await interaction.reply({ 
                            content: '❌ حدث خطأ في عرض نموذج القالب.', 
                            ephemeral: true 
                        }).catch(() => {});
                    }
                    return;

                case 'report_advanced_settings':
                    responseContent = 'اختر من الإعدادات المتقدمة:';
                    newComponents = [
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('report_set_channel_button')
                                .setLabel('تحديد قناة التقارير')
                                .setStyle(ButtonStyle.Success),
                            new ButtonBuilder()
                                .setCustomId('report_set_dms_button')
                                .setLabel('تحديد خاص الأونر')
                                .setStyle(ButtonStyle.Success),
                            new ButtonBuilder()
                                .setCustomId('report_toggle_points')
                                .setLabel('تغيير نظام النقاط')
                                .setStyle(ButtonStyle.Success)
                        ),
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('report_set_approvers')
                                .setLabel('تحديد المعتمدين')
                                .setStyle(ButtonStyle.Primary),
                            new ButtonBuilder()
                                .setCustomId('report_back_to_main')
                                .setLabel('➡️ العودة')
                                .setStyle(ButtonStyle.Secondary)
                        )
                    ];
                    break;

                case 'report_set_approvers':
                    await interaction.editReply({
                        content: 'اختر نوع المعتمدين للموافقة على التقارير:',
                        components: [
                            new ActionRowBuilder().addComponents(
                                new StringSelectMenuBuilder()
                                    .setCustomId('report_select_approver_type')
                                    .setPlaceholder('اختر نوع المعتمدين')
                                    .addOptions([
                                        {
                                            label: 'الأونرات فقط',
                                            description: 'فقط أصحاب البوت يمكنهم الموافقة',
                                            value: 'owners'
                                        },
                                        {
                                            label: 'رولات محددة',
                                            description: 'أعضاء برولات معينة يمكنهم الموافقة',
                                            value: 'roles'
                                        },
                                        {
                                            label: 'مسؤوليات محددة',
                                            description: 'أعضاء مسؤوليات معينة يمكنهم الموافقة',
                                            value: 'responsibility'
                                        }
                                    ])
                            ),
                            new ActionRowBuilder().addComponents(
                                new ButtonBuilder()
                                    .setCustomId('report_advanced_settings')
                                    .setLabel('➡️ العودة')
                                    .setStyle(ButtonStyle.Secondary)
                            )
                        ]
                    });
                    return;

                case 'report_set_channel_button':
                    const channelMenu = new ChannelSelectMenuBuilder()
                        .setCustomId('report_channel_select')
                        .setPlaceholder('اختر قناة لإرسال التقارير إليها')
                        .addChannelTypes(ChannelType.GuildText);

                    responseContent = 'اختر القناة من القائمة:';
                    newComponents = [
                        new ActionRowBuilder().addComponents(channelMenu),
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('report_advanced_settings')
                                .setLabel('➡️ العودة')
                                .setStyle(ButtonStyle.Secondary)
                        )
                    ];
                    break;
            }

            // Handle approve/reject buttons (special handling)
            if (customId.startsWith('report_approve_') || customId.startsWith('report_reject_')) {
                const reportId = customId.replace('report_approve_', '').replace('report_reject_', '');
                const reportData = client.pendingReports?.get(reportId);
                const isApprove = customId.startsWith('report_approve_');

                if (!reportData) {
                    return await interaction.reply({ 
                        content: '❌ لم يتم العثور على هذا التقرير أو تمت معالجته مسبقاً.', 
                        ephemeral: true
                    });
                }

                // التحقق من أن التقرير لم تتم معالجته من قبل
                if (reportData.processed) {
                    return await interaction.reply({ 
                        content: '❌ تمت معالجة هذا التقرير مسبقاً.', 
                        ephemeral: true
                    });
                }

                // Check permissions BEFORE processing
                let hasPermission = false;

                if (config.approverType === 'owners') {
                    hasPermission = BOT_OWNERS.includes(interaction.user.id);
                } else if (config.approverType === 'roles' && config.approverTargets && config.approverTargets.length > 0) {
                    hasPermission = interaction.member.roles.cache.some(role => config.approverTargets.includes(role.id));
                } else if (config.approverType === 'responsibility' && config.approverTargets && config.approverTargets.length > 0) {
                    // Check if user is in any of the specified responsibilities
                    for (const respName of config.approverTargets) {
                        if (responsibilities[respName] && responsibilities[respName].responsibles) {
                            if (responsibilities[respName].responsibles.includes(interaction.user.id)) {
                                hasPermission = true;
                                break;
                            }
                        }
                    }
                } else {
                    // Default to owners if not configured
                    hasPermission = BOT_OWNERS.includes(interaction.user.id);
                }

                if (!hasPermission) {
                    return await interaction.reply({ 
                        content: '❌ عفوي!', 
                        ephemeral: true
                    });
                }

                // وضع علامة أن التقرير قيد المعالجة
                reportData.processed = true;
                reportData.processedBy = interaction.user.id;
                reportData.processedAt = Date.now();
                client.pendingReports.set(reportId, reportData);

                // Update the original message
                const originalEmbed = EmbedBuilder.from(interaction.message.embeds[0])
                    .setColor(isApprove ? '#00ff00' : '#ff0000')
                    .addFields([
                        { 
                            name: '✅ الحالة', 
                            value: isApprove ? `تمت الموافقة بواسطة <@${interaction.user.id}>` : `تم الرفض بواسطة <@${interaction.user.id}>`, 
                            inline: false 
                        }
                    ]);

                await interaction.editReply({ embeds: [originalEmbed], components: [] });

                // Award points if approved and pointsOnReport is true
                if (isApprove && config.pointsOnReport) {
                    const { claimerId, responsibilityName, timestamp } = reportData;
                    if (!points[responsibilityName]) points[responsibilityName] = {};
                    if (!points[responsibilityName][claimerId]) points[responsibilityName][claimerId] = {};
                    if (typeof points[responsibilityName][claimerId] === 'number') {
                        const oldPoints = points[responsibilityName][claimerId];
                        points[responsibilityName][claimerId] = {
                            [Date.now() - (35 * 24 * 60 * 60 * 1000)]: oldPoints
                        };
                    }
                    if (!points[responsibilityName][claimerId][timestamp]) {
                        points[responsibilityName][claimerId][timestamp] = 0;
                    }
                    points[responsibilityName][claimerId][timestamp] += 1;
                    scheduleSave();
                }

                // Send notification to the user
                try {
                    const user = await client.users.fetch(reportData.claimerId);
                    const notificationEmbed = colorManager.createEmbed()
                        .setTitle(isApprove ? '✅ تمت الموافقة على تقريرك' : '❌ تم رفض تقريرك')
                        .setDescription(`**المسؤولية :** ${reportData.responsibilityName}\n**السبب :** ${reportData.reason}\n**التقرير :** ${reportData.reportText || 'غير متوفر'}`)
                        .setColor(isApprove ? '#00ff00' : '#ff0000')
                        .setFooter({ text: `${isApprove ? 'تمت الموافقة' : 'تم الرفض'} بواسطة ${interaction.user.tag}` })
                        .setTimestamp();

                    if (isApprove && config.pointsOnReport) {
                        notificationEmbed.addFields([
                            { name: ' النقاط', value: '✅️', inline: false }
                        ]);
                    }

                    await user.send({ embeds: [notificationEmbed] });
                } catch (err) {
                    console.error('Failed to send notification to user:', err);
                }

                // Remove from pending reports
                client.pendingReports.delete(reportId);
                scheduleSave();

                return;
            }

            // Handle ask clarification button
            if (customId.startsWith('report_ask_clarification_')) {
                const reportId = customId.replace('report_ask_clarification_', '');
                const reportData = client.pendingReports?.get(reportId);

                if (!reportData) {
                    return await interaction.reply({ 
                        content: '❌ لم يتم العثور على هذا التقرير أو تمت معالجته مسبقاً.', 
                        ephemeral: true
                    });
                }

                // التحقق من أن التقرير لم تتم معالجته من قبل
                if (reportData.processed) {
                    return await interaction.reply({ 
                        content: '❌ تمت معالجة هذا التقرير مسبقاً.', 
                        ephemeral: true
                    });
                }

                // Check permissions
                let hasPermission = false;

                if (config.approverType === 'owners') {
                    hasPermission = BOT_OWNERS.includes(interaction.user.id);
                } else if (config.approverType === 'roles' && config.approverTargets && config.approverTargets.length > 0) {
                    hasPermission = interaction.member.roles.cache.some(role => config.approverTargets.includes(role.id));
                } else if (config.approverType === 'responsibility' && config.approverTargets && config.approverTargets.length > 0) {
                    for (const respName of config.approverTargets) {
                        if (responsibilities[respName] && responsibilities[respName].responsibles) {
                            if (responsibilities[respName].responsibles.includes(interaction.user.id)) {
                                hasPermission = true;
                                break;
                            }
                        }
                    }
                } else {
                    hasPermission = BOT_OWNERS.includes(interaction.user.id);
                }

                if (!hasPermission) {
                    return await interaction.reply({ 
                        content: '❌ ليس لديك صلاحية لطلب توضيح!', 
                        ephemeral: true
                    });
                }

                // Show modal to ask for clarification question
                const clarificationModal = new ModalBuilder()
                    .setCustomId(`report_clarification_question_${reportId}`)
                    .setTitle('طلب توضيح');

                const questionInput = new TextInputBuilder()
                    .setCustomId('clarification_question')
                    .setLabel('ما الذي تريد توضيحه؟')
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder('مثال: هل يمكنك توضيح النقطة الثالثة بشكل أكبر؟')
                    .setRequired(true);

                clarificationModal.addComponents(new ActionRowBuilder().addComponents(questionInput));

                try {
                    await interaction.showModal(clarificationModal);
                } catch (error) {
                    console.error('Error showing clarification modal:', error);
                    await interaction.reply({ 
                        content: '❌ حدث خطأ في عرض نموذج طلب التوضيح.', 
                        ephemeral: true 
                    }).catch(() => {});
                }
                return;
            }

            // Handle saving if needed
            if (shouldSave) {
                if (saveReportsConfig(guildId, config)) {
                    if (responseContent) {
                        await interaction.followUp({ content: responseContent, ephemeral: true });
                    }
                } else {
                    await interaction.followUp({ content: '❌ فشل في حفظ الإعدادات.', ephemeral: true });
                }
            }

            // Update the message
            try {
                if (shouldShowMain) {
                    if (interaction.deferred) {
                        await interaction.editReply({ 
                            content: '', 
                            embeds: [createMainEmbed(client, guildId)], 
                            components: [createMainButtons(guildId)] 
                        });
                    } else {
                        await interaction.update({ 
                            content: '', 
                            embeds: [createMainEmbed(client, guildId)], 
                            components: [createMainButtons(guildId)] 
                        });
                    }
                } else if (newComponents) {
                    if (interaction.deferred) {
                        await interaction.editReply({ 
                            content: responseContent, 
                            embeds: [], 
                            components: newComponents 
                        });
                    } else {
                        await interaction.update({ 
                            content: responseContent, 
                            embeds: [], 
                            components: newComponents 
                        });
                    }
                }
            } catch (editError) {
                console.error('خطأ في تحديث الرسالة:', editError);

                // محاولة إرسال رد جديد إذا فشل التحديث
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: responseContent || '✅ تم تنفيذ الإجراء بنجاح',
                        ephemeral: true
                    }).catch(() => {});
                }
            }

        } else if (interaction.isStringSelectMenu() || interaction.isChannelSelectMenu() || interaction.isRoleSelectMenu()) {
            let shouldSave = false;
            let responseContent = '';

            // Handle other select menus
            if (interaction.isStringSelectMenu()) {
                switch (customId) {
                    case 'report_template_edit_select':
                        // فتح Modal لتعديل قالب المسؤولية المحددة
                        const selectedResp = interaction.values[0];

                        if (selectedResp === 'none') {
                            await interaction.reply({
                                content: '❌ لا توجد مسؤوليات! يجب إنشاء مسؤوليات أولاً.',
                                ephemeral: true
                            });
                            return;
                        }

                        const currentTemplate = config.templates[selectedResp] || '';

                        const editModal = new ModalBuilder()
                            .setCustomId(`report_template_save_modal_${selectedResp}`)
                            .setTitle(`تعديل قالب: ${selectedResp}`);

                        const templateInput = new TextInputBuilder()
                            .setCustomId('template_text')
                            .setLabel('القالب الجديد')
                            .setStyle(TextInputStyle.Paragraph)
                            .setPlaceholder('اكتب القالب الجديد للمسؤولية...')
                            .setValue(currentTemplate)
                            .setRequired(true);

                        editModal.addComponents(new ActionRowBuilder().addComponents(templateInput));

                        try {
                            await interaction.showModal(editModal);
                        } catch (error) {
                            console.error('Error showing edit modal:', error);
                            await interaction.reply({ 
                                content: '❌ حدث خطأ في عرض نموذج التعديل.', 
                                ephemeral: true 
                            }).catch(() => {});
                        }
                        return;

                    case 'report_select_approver_type':
                        const approverType = interaction.values[0];
                        config.approverType = approverType;

                        if (approverType === 'owners') {
                            config.approverTargets = [];
                            config.approverType = 'owners'; // التأكد من حفظ النوع
                            if (saveReportsConfig(guildId, config)) {
                                // إعادة تحميل الإعدادات المحدثة
                                const updatedConfig = loadReportsConfig(guildId);
                                await interaction.editReply({
                                    content: '✅ تم تعيين المعتمدين: الأونرات فقط',
                                    embeds: [createMainEmbed(client, guildId)],
                                    components: [createMainButtons(guildId)]
                                });
                            } else {
                                await interaction.editReply({
                                    content: '❌ فشل في حفظ الإعدادات',
                                    embeds: [],
                                    components: []
                                });
                            }
                            return;
                        } else if (approverType === 'roles') {
                            await interaction.editReply({
                                content: 'اختر الرولات المعتمدة للموافقة على التقارير:',
                                embeds: [],
                                components: [
                                    new ActionRowBuilder().addComponents(
                                        new RoleSelectMenuBuilder()
                                            .setCustomId('report_select_approver_roles')
                                            .setPlaceholder('اختر الرولات المعتمدة...')
                                            .setMaxValues(10)
                                    ),
                                    new ActionRowBuilder().addComponents(
                                        new ButtonBuilder()
                                            .setCustomId('report_set_approvers')
                                            .setLabel('➡️ العودة')
                                            .setStyle(ButtonStyle.Secondary)
                                    )
                                ]
                            });
                            return;
                        } else if (approverType === 'responsibility') {
                            const respOptions = Object.keys(responsibilities).slice(0, 25).map(name => ({
                                label: name,
                                value: name,
                                description: `السماح لمسؤولي ${name} بالموافقة`
                            }));

                            if (respOptions.length === 0) {
                                await interaction.editReply({
                                    content: '❌ لا توجد مسؤوليات معرفة! يرجى إنشاء مسؤوليات أولاً.',
                                    components: []
                                });
                                return;
                            }

                            await interaction.editReply({
                                content: 'اختر المسؤوليات المعتمدة للموافقة على التقارير:',
                                embeds: [],
                                components: [
                                    new ActionRowBuilder().addComponents(
                                        new StringSelectMenuBuilder()
                                            .setCustomId('report_select_approver_responsibilities')
                                            .setPlaceholder('اختر المسؤوليات المعتمدة...')
                                            .setMaxValues(Math.min(respOptions.length, 10))
                                            .addOptions(respOptions)
                                    ),
                                    new ActionRowBuilder().addComponents(
                                        new ButtonBuilder()
                                            .setCustomId('report_set_approvers')
                                            .setLabel('➡️ العودة')
                                            .setStyle(ButtonStyle.Secondary)
                                    )
                                ]
                            });
                            return;
                        }
                        break;

                    case 'report_select_approver_responsibilities':
                        config.approverTargets = interaction.values;
                        config.approverType = 'responsibility'; // التأكد من حفظ النوع
                        if (saveReportsConfig(guildId, config)) {
                            // إعادة تحميل الإعدادات المحدثة
                            const updatedConfig = loadReportsConfig(guildId);
                            await interaction.editReply({
                                content: `✅ تم تعيين المعتمدين: ${interaction.values.join(', ')}`,
                                embeds: [createMainEmbed(client, guildId)],
                                components: [createMainButtons(guildId)]
                            });
                        } else {
                            await interaction.editReply({
                                content: '❌ فشل في حفظ الإعدادات',
                                embeds: [],
                                components: []
                            });
                        }
                        return;

                    case 'report_confirm_req_report':
                        config.requiredFor = interaction.values;
                        shouldSave = true;
                        responseContent = '✅ تم تحديث المسؤوليات المطلوب تقرير لها بنجاح.';
                        break;

                    case 'report_confirm_req_approval':
                        config.approvalRequiredFor = interaction.values;
                        shouldSave = true;
                        responseContent = '✅ تم تحديث المسؤوليات المطلوب موافقة تقريرها بنجاح.';
                        break;
                }
            }

            // Handle role selection for approvers
            if (interaction.isRoleSelectMenu() && customId === 'report_select_approver_roles') {
                // Defer the update first
                if (!interaction.deferred && !interaction.replied) {
                    await interaction.deferUpdate();
                }

                config.approverTargets = interaction.values;
                config.approverType = 'roles'; // التأكد من حفظ النوع
                if (saveReportsConfig(guildId, config)) {
                    const rolesMentions = interaction.values.map(id => `<@&${id}>`).join(', ');
                    // إعادة تحميل الإعدادات المحدثة
                    const updatedConfig = loadReportsConfig(guildId);
                    await interaction.editReply({
                        content: `✅ تم تعيين المعتمدين: ${rolesMentions}`,
                        embeds: [createMainEmbed(client, guildId)],
                        components: [createMainButtons(guildId)]
                    });
                } else {
                    await interaction.editReply({
                        content: '❌ فشل في حفظ الإعدادات',
                        embeds: [],
                        components: []
                    });
                }
                return;
            }

            // Handle channel selection
            if (interaction.isChannelSelectMenu() && customId === 'report_channel_select') {
                const channelId = interaction.values[0];
                config.reportChannel = channelId;
                shouldSave = true;
                responseContent = `✅ تم تحديد قناة التقارير: <#${channelId}>`;
            }

            // Handle saving and response
            if (shouldSave) {
                if (saveReportsConfig(guildId, config)) {
                    if (responseContent) {
                        await interaction.followUp({ content: responseContent, ephemeral: true });
                    }
                } else {
                    await interaction.followUp({ content: '❌ فشل في حفظ الإعدادات.', ephemeral: true });
                }
            }

            // Return to main menu if needed
            if (responseContent && !responseContent.startsWith('✅')) {
                // If it's not a success message, show the main menu
                if (interaction.deferred) {
                    await interaction.editReply({ 
                        content: responseContent, 
                        embeds: [createMainEmbed(client, guildId)], 
                        components: [createMainButtons(guildId)] 
                    });
                } else {
                    await interaction.update({ 
                        content: responseContent, 
                        embeds: [createMainEmbed(client, guildId)], 
                        components: [createMainButtons(guildId)] 
                    });
                }
            } else if (responseContent) {
                // If it's a success message, just show the confirmation
                if (interaction.deferred) {
                    await interaction.editReply({ 
                        content: responseContent, 
                        embeds: [], 
                        components: [] 
                    });
                } else {
                    await interaction.update({ 
                        content: responseContent, 
                        embeds: [], 
                        components: [] 
                    });
                }
            }


        }

    } catch (error) {
        console.error('Error in report interaction handler:', error);

        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.followUp({ 
                    content: '❌ حدث خطأ في معالجة التفاعل.', 
                    ephemeral: true 
                });
            } else {
                await interaction.reply({ 
                    content: '❌ حدث خطأ في معالجة التفاعل.', 
                    ephemeral: true 
                });
            }
        } catch (followUpError) {
            console.error('Error sending error message:', followUpError);
        }
    }
}

// تسجيل معالج التفاعلات المستقل
function registerInteractionHandler(client) {
    console.log('🔧 تسجيل معالج تفاعلات التقارير...');

    client.on('interactionCreate', async (interaction) => {
        // التحقق من أن التفاعل يخص نظام التقارير
        if (!interaction.customId || !interaction.customId.startsWith('report_')) {
            return;
        }

        console.log(`[Report] معالجة تفاعل: ${interaction.customId} من ${interaction.user.tag}`);

        try {
            // إعادة تحميل البيانات من الملفات
            const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
            const botConfigPath = path.join(__dirname, '..', 'data', 'botConfig.json');

            let responsibilities = {};
            let points = ticketState.loadPoints();
            let BOT_OWNERS = [];

            try {
                if (fs.existsSync(responsibilitiesPath)) {
                    responsibilities = JSON.parse(fs.readFileSync(responsibilitiesPath, 'utf8'));
                }
                if (fs.existsSync(botConfigPath)) {
                    const botConfig = JSON.parse(fs.readFileSync(botConfigPath, 'utf8'));
                    BOT_OWNERS = botConfig.owners || [];
                }
            } catch (error) {
                console.error('❌ خطأ في قراءة البيانات:', error);
            }

            // دالة للحفظ
            const scheduleSave = () => {
                try {
                    ticketState.savePoints(points);
                    const botConfig = JSON.parse(fs.readFileSync(botConfigPath, 'utf8'));
                    const pendingReportsObj = {};
                    for (const [key, value] of client.pendingReports.entries()) {
                        pendingReportsObj[key] = value;
                    }
                    botConfig.pendingReports = pendingReportsObj;
                    fs.writeFileSync(botConfigPath, JSON.stringify(botConfig, null, 2));
                } catch (error) {
                    console.error('❌ خطأ في حفظ البيانات:', error);
                }
            };

            // إنشاء كائن السياق
            const context = {
                client,
                responsibilities,
                points,
                scheduleSave,
                BOT_OWNERS,
                reportsConfig: {},
                logConfig: client.logConfig,
                colorManager
            };

            // استدعاء المعالج
            await handleInteraction(interaction, context);

        } catch (error) {
            console.error('خطأ في معالج تفاعلات التقارير:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ حدث خطأ في معالجة التفاعل.',
                    ephemeral: true
                }).catch(() => {});
            }
        }
    });

    console.log('✅ تم تسجيل معالج تفاعلات التقارير بنجاح');
}

module.exports = { name, execute, handleInteraction, registerInteractionHandler };
