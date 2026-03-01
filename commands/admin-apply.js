const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const { collectUserStats, createUserStatsEmbed } = require('../utils/userStatsCollector');
const colorManager = require('../utils/colorManager');

const adminApplicationsPath = path.join(__dirname, '..', 'data', 'adminApplications.json');

// دالة لقراءة إعدادات التقديم الإداري
function loadAdminApplicationSettings() {
    try {
        if (fs.existsSync(adminApplicationsPath)) {
            const data = fs.readFileSync(adminApplicationsPath, 'utf8');
            return JSON.parse(data);
        }
        return {
            settings: {
                applicationChannel: null,
                approvers: { type: "roles", list: [] },
                maxPendingPerAdmin: 3,
                rejectCooldownHours: 24
            },
            pendingApplications: {},
            rejectedCooldowns: {}
        };
    } catch (error) {
        console.error('خطأ في قراءة إعدادات التقديم الإداري:', error);
        return {
            settings: {
                applicationChannel: null,
                approvers: { type: "roles", list: [] },
                maxPendingPerAdmin: 3,
                rejectCooldownHours: 24
            },
            pendingApplications: {},
            rejectedCooldowns: {}
        };
    }
}

// دالة لحفظ إعدادات التقديم الإداري
function saveAdminApplicationSettings(data) {
    try {
        fs.writeFileSync(adminApplicationsPath, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('خطأ في حفظ إعدادات التقديم الإداري:', error);
        return false;
    }
}

// دالة لتحميل أدوار المشرفين
function loadAdminRoles() {
    try {
        const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
        if (fs.existsSync(adminRolesPath)) {
            const data = fs.readFileSync(adminRolesPath, 'utf8');
            const adminRoles = JSON.parse(data);
            return Array.isArray(adminRoles) ? adminRoles : [];
        }
        return [];
    } catch (error) {
        console.error('خطأ في تحميل أدوار المشرفين:', error);
        return [];
    }
}

// التحقق من صلاحية استخدام الأمر
function canUseCommand(member) {
    const adminRoles = loadAdminRoles();
    const hasAdminRole = member.roles.cache.some(role => adminRoles.includes(role.id));

    // فحص إذا كان مالك السيرفر
    const isGuildOwner = member.guild.ownerId === member.id;

    // فحص إذا كان من مالكي البوت
    const BOT_OWNERS = global.BOT_OWNERS || [];
    const isBotOwner = BOT_OWNERS.includes(member.id);

    return hasAdminRole || isGuildOwner || isBotOwner;
}

// التحقق من وجود أدوار إدارية للمرشح
function candidateHasAdminRoles(member) {
    const adminRoles = loadAdminRoles();
    return member.roles.cache.some(role => adminRoles.includes(role.id));
}

// التحقق من الكولداون
function isInCooldown(userId, settings) {
    if (!settings.rejectedCooldowns) return false;
    const cooldown = settings.rejectedCooldowns[userId];
    if (!cooldown) return false;

    const cooldownEnd = new Date(cooldown.rejectedAt).getTime() + (settings.settings.rejectCooldownHours * 60 * 60 * 1000);
    const now = Date.now();

    if (now >= cooldownEnd) {
        // انتهى الكولداون، احذفه
        delete settings.rejectedCooldowns[userId];
        saveAdminApplicationSettings(settings);
        return false;
    }

    return {
        inCooldown: true,
        endsAt: new Date(cooldownEnd),
        timeLeft: cooldownEnd - now
    };
}

// التحقق من الطلبات المعلقة للمرشح
function hasPendingApplication(userId, settings) {
    if (!settings.pendingApplications) return false;
    return Object.values(settings.pendingApplications).some(app => app.candidateId === userId);
}

// عد الطلبات المعلقة للإداري
function countPendingApplicationsByAdmin(adminId, settings) {
    if (!settings.pendingApplications) return 0;
    return Object.values(settings.pendingApplications).filter(app => app.requesterId === adminId).length;
}

// تنسيق الوقت المتبقي
function formatTimeLeft(milliseconds) {
    const hours = Math.floor(milliseconds / (1000 * 60 * 60));
    const minutes = Math.floor((milliseconds % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 0) {
        return `${hours}h and ${minutes}m`;
    } else {
        return `${minutes}m`;
    }
}

module.exports = {
    name: 'admin-apply',
    aliases: ['إدارة', 'ادارة' ,'admin'],
    description: 'تقديم شخص للحصول على صلاحيات إدارية',

    async execute(interaction) {
        try {
            // التحقق من صلاحية استخدام الأمر
            if (!canUseCommand(interaction.member)) {
                await interaction.reply({
                    content: '**ليس لديك صلاحية لاستخدام هذا الأمر.**'
                });
                return;
            }

            // تحميل الإعدادات
            const settings = loadAdminApplicationSettings();

            // التحقق من إعداد النظام
            if (!settings.settings.applicationChannel) {
                await interaction.reply({
                    content: '**لم يتم إعداد نظام التقديم الإداري بعد. استخدم أمر `setadmin` أولاً.**'
                });
                return;
            }

            // التحقق من وجود القناة
            const applicationChannel = interaction.guild.channels.cache.get(settings.settings.applicationChannel);
            if (!applicationChannel) {
                await interaction.reply({
                    content: '**روم التقديم الإداري غير موجودة أو محذوفة. استخدم أمر `setadmin` لإعادة تحديدها.**'
                });
                return;
            }

            // التحقق من تحديد رول القبول
            if (!settings.settings.adminRolesToGrant || settings.settings.adminRolesToGrant.length === 0) {
                await interaction.reply({
                    content: '**لم يتم تحديد رول القبول الإداري بعد. استخدم أمر `setadmin` وحدد \"Acceptance Role\" أولاً.**'
                });
                return;
            }

            // التحقق من حد الطلبات المعلقة للإداري
            const pendingCount = countPendingApplicationsByAdmin(interaction.user.id, settings);
            if (pendingCount >= settings.settings.maxPendingPerAdmin) {
                await interaction.reply({
                    content: `لديك بالفعل ${pendingCount} طلبات معلقة. الحد الأقصى هو ${settings.settings.maxPendingPerAdmin} طلبات.`
                });
                return;
            }

            // استخراج المستخدم المرشح من الخيارات
            let candidate = null;
            let candidateId = null;

            // message command - استخراج المرشح من محتوى الرسالة
            const messageContent = interaction.message?.content || '';
            const mentionMatch = messageContent.match(/<@!?(\d+)>/);

            if (!mentionMatch) {
                await interaction.reply({
                    content: '** ادارة @العضو**'
                });
                return;
            }

            candidateId = mentionMatch[1];
            candidate = await interaction.guild.members.fetch(candidateId).catch(() => null);

            if (!candidate) {
                await interaction.reply({
                    content: '**لم يتم العثور على المستخدم المرشح في السيرفر.**'
                });
                return;
            }

            // التحقق من أن المرشح ليس بوت
            if (candidate.user.bot) {
                await interaction.reply({
                    content: '**لا يمكن ترشيح البوتات  للحصول على ادارة.**'
                });
                return;
            }

            // التحقق من وجود أدوار إدارية للمرشح
            if (candidateHasAdminRoles(candidate)) {
                await interaction.reply({
                    content: `**<@${candidateId}> لديه بالفعل رولات إدارية.**`
                });
                return;
            }

            // التحقق من الكولداون
            const cooldownCheck = isInCooldown(candidateId, settings);
            if (cooldownCheck) {
                const timeLeft = formatTimeLeft(cooldownCheck.timeLeft);
                await interaction.reply({
                    content: `**<@${candidateId}> تم رفضه مسبقاً وعليه كولداون.\nالوقت المتبقي: ${timeLeft}**`
                });
                return;
            }

            // التحقق من وجود طلب معلق للمرشح
            if (hasPendingApplication(candidateId, settings)) {
                await interaction.reply({
                    content: `**<@${candidateId}> لديه بالفعل طلب تقديم معلق.**`
                });
                return;
            }

            // جمع إحصائيات المرشح
            await interaction.deferReply();

            const userStats = await collectUserStats(candidate);
            const statsEmbed = await createUserStatsEmbed(userStats, colorManager);

            // إنشاء معرف فريد أبسط للطلب مع معلومات إضافية
            const applicationId = `${Date.now()}_${candidateId}_${interaction.user.id}`;

            // إنشاء embed محسّن للآيفون
            const simpleEmbed = await createUserStatsEmbed(userStats, colorManager, true, interaction.member.displayName, `<@${interaction.user.id}>`);

            // تقليل حجم الـ embed للآيفون
            if (simpleEmbed.data && simpleEmbed.data.fields) {
                // الحد الأقصى للحقول: 3-4 حقول لضمان الظهور الكامل
                const maxFields = 4;
                if (simpleEmbed.data.fields.length > maxFields) {
                    simpleEmbed.data.fields = simpleEmbed.data.fields.slice(0, maxFields);
                }

                // تقصير نصوص الحقول إذا كانت طويلة
                simpleEmbed.data.fields = simpleEmbed.data.fields.map(field => {
                    if (field.value && field.value.length > 200) {
                        field.value = field.value.substring(0, 197) + '...';
                    }
                    return field;
                });
            }

            // تقصير الوصف إذا كان طويلاً
            if (simpleEmbed.data && simpleEmbed.data.description && simpleEmbed.data.description.length > 500) {
                simpleEmbed.data.description = simpleEmbed.data.description.substring(0, 497) + '...';
            }

            // إنشاء أزرار الموافقة والرفض
            const approveButton = new ButtonBuilder()
                .setCustomId(`admin_approve_${applicationId}`)
                .setLabel('Approve')
                .setEmoji('<:emoji_1:1436850272734285856>')
                .setStyle(ButtonStyle.Secondary);

            const rejectButton = new ButtonBuilder()
                .setCustomId(`admin_reject_modal_trigger_${applicationId}`)
                .setLabel('Reject')
                .setEmoji('<:emoji_1:1436850215154880553>')
                .setStyle(ButtonStyle.Secondary);

            // إنشاء منيو للتفاصيل الإضافية (للمعتمدين فقط)
            const detailsMenu = new StringSelectMenuBuilder()
                .setCustomId(`admin_details_${applicationId}`)
                .setPlaceholder('تفاصيل عن العضو')
                .addOptions([
                    {
                        label: 'Dates',
                        description: 'عرض تواريخ الانضمام وإنشاء الحساب',
                        value: 'dates',

                    },
                    {
                        label: 'Evaluation',
                        description: 'عرض تقييم العضو والمعايير',
                        value: 'evaluation',

                    },
                    {
                        label: 'Roles',
                        description: 'عرض جميع الرولات للعضو',
                        value: 'roles',

                    },
                    {
                        label: 'Stats',
                        description: 'عرض تفاصيل النشاط',
                        value: 'advanced_stats',

                    },
                    {
                        label: 'first ep',
                        description: 'العودة للعرض الأساسي',
                        value: 'simple_view',

                    }
                ]);

            const row1 = new ActionRowBuilder()
                .addComponents(approveButton, rejectButton);

            const row2 = new ActionRowBuilder()
                .addComponents(detailsMenu);

            // إرسال الطلب إلى قناة التقديم أولاً
            try {
                const sentMessage = await applicationChannel.send({
                    embeds: [simpleEmbed],
                    components: [row1, row2]
                });

                // حفظ الطلب في البيانات فقط بعد نجاح الإرسال
                settings.pendingApplications[applicationId] = {
                    candidateId: candidateId,
                    candidateMention: `<@${candidateId}>`,
                    requesterId: interaction.user.id,
                    requesterMention: `<@${interaction.user.id}>`,
                    createdAt: new Date().toISOString(),
                    userStats: userStats
                };

                if (saveAdminApplicationSettings(settings)) {
                    // إرسال رسالة نجاح للمستخدم



                    // إضافة ريأكشن للرسالة الأصلية
                    if (interaction.message) {
                        try {
                            await interaction.message.react('✅');
                        } catch (reactError) {
                            console.log('⚠️ فشل إضافة رد الفعل (الرسالة قد تكون محذوفة):', reactError.message);
                        }
                    }

                    console.log(`📋 تم إنشاء طلب تقديم إداري: ${candidateId} بواسطة ${interaction.user.id}`);
                } else {
                    await interaction.editReply({
                        content: '**⚠️ تم إرسال الطلب ولكن فشل في حفظ البيانات. قد تحدث مشاكل لاحقاً.**'
                    });
                }

            } catch (channelError) {
                console.error('خطأ في إرسال الطلب للقناة:', channelError);


                if (interaction.message) {
                        try {
                            await interaction.message.react('❌️');
                        } catch (reactError) {
                            console.log('⚠️ فشل إضافة رد الفعل (الرسالة قد تكون محذوفة):', reactError.message);
                        }
                }
                return; // إيقاف العملية هنا
            }

        } catch (error) {
            console.error('خطأ في أمر إدارة:', error);

            const errorMessage = 'حدث خطأ في معالجة الطلب. حاول مرة أخرى.';

            if (interaction.deferred) {
                await interaction.editReply({ content: errorMessage });
            } else {
                await interaction.reply({ content: errorMessage });
            }
        }
    }
};

// دالة للتحقق من صلاحيات المعتمدين
function canApproveApplication(member, settings) {
    const approvers = settings.settings.approvers;

    // فحص إذا كان من مالكي البوت
    const BOT_OWNERS = global.BOT_OWNERS || [];
    const isBotOwner = BOT_OWNERS.includes(member.id);

    // فحص إذا كان مالك السيرفر
    const isGuildOwner = member.guild.ownerId === member.id;

    if (isBotOwner || isGuildOwner) {
        return true;
    }

    if (approvers.type === 'owners') {
        return isBotOwner;
    } else if (approvers.type === 'roles') {
        return member.roles.cache.some(role => approvers.list.includes(role.id));
    } else if (approvers.type === 'responsibility') {
        // فحص المسؤوليات
        const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
        try {
            if (fs.existsSync(responsibilitiesPath)) {
                const responsibilitiesData = JSON.parse(fs.readFileSync(responsibilitiesPath, 'utf8'));
                const targetResp = approvers.list[0];

                if (responsibilitiesData[targetResp] && responsibilitiesData[targetResp].responsibles) {
                    return responsibilitiesData[targetResp].responsibles.includes(member.id);
                }
            }
        } catch (error) {
            console.error('خطأ في فحص المسؤوليات:', error);
        }
        return false;
    }

    return false;
}

// معالج تفاعلات نظام التقديم الإداري مع تحسينات الأمان والدقة
async function handleAdminApplicationInteraction(interaction) {
    try {
        const customId = interaction.customId;

        // فحص أولي للتفاعل
        if (!customId || typeof customId !== 'string') {
            console.log('❌ معرف تفاعل غير صحيح');
            return false;
        }

        // التحقق من أن التفاعل متعلق بالتقديم الإداري
        if (!customId.startsWith('admin_approve_') && !customId.startsWith('admin_reject_') && !customId.startsWith('admin_select_roles_') && !customId.startsWith('admin_details_')) {
            console.log('⚠️ التفاعل ليس متعلق بنظام التقديم الإداري:', customId);
            return false;
        }

        // فحص صحة التفاعل
        if (interaction.replied || interaction.deferred) {
            console.log('⚠️ تم تجاهل تفاعل تم الرد عليه مسبقاً');
            return true;
        }

        // فحص عمر التفاعل
        const interactionAge = Date.now() - interaction.createdTimestamp;
        if (interactionAge > 10 * 60 * 1000) { // 10 دقائق
            console.log('⚠️ تم تجاهل تفاعل قديم');
            return true;
        }

        // فحص إضافي للتأكد من صحة معرف التفاعل
        if (!customId || typeof customId !== 'string' || customId.length < 10) {
            console.log('⚠️ معرف تفاعل غير صحيح أو قصير جداً');
            return true;
        }

        console.log('✅ معالجة تفاعل التقديم الإداري:', customId);

        // معالج فتح مودال الرفض
        if (customId.startsWith('admin_reject_modal_trigger_')) {
            const applicationId = customId.replace('admin_reject_modal_trigger_', '');
            const settings = loadAdminApplicationSettings();
            if (!canApproveApplication(interaction.member, settings)) {
                await interaction.reply({ content: '❌ **مب مسؤول؟ والله ماوريك.**', ephemeral: true });
                return true;
            }

            const modal = new ModalBuilder()
                .setCustomId(`admin_reject_modal_submit_${applicationId}`)
                .setTitle('سبب الرفض');

            const reasonInput = new TextInputBuilder()
                .setCustomId('reject_reason')
                .setLabel('اذكر سبب الرفض')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setPlaceholder('اكتب سبب الرفض هنا ليتم إرساله للشخص...')
                .setMaxLength(500);

            modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
            await interaction.showModal(modal);
            return true;
        }

        // معالج إرسال مودال الرفض
        if (interaction.isModalSubmit() && customId.startsWith('admin_reject_modal_submit_')) {
            const applicationId = customId.replace('admin_reject_modal_submit_', '');
            const reason = interaction.fields.getTextInputValue('reject_reason');
            
            const settings = loadAdminApplicationSettings();
            const application = settings.pendingApplications[applicationId];

            if (!application) {
                await interaction.reply({ content: '**❌ لم يتم العثور على الطلب.**', ephemeral: true });
                return true;
            }

            // تنفيذ الرفض
            const candidateId = application.candidateId;
            
            // تحديث الكولداون
            settings.rejectedCooldowns[candidateId] = {
                rejectedAt: new Date().toISOString(),
                rejectedBy: interaction.user.id,
                rejectorName: interaction.member.displayName,
                reason: reason
            };

            // حذف الطلب من الطلبات المعلقة
            delete settings.pendingApplications[applicationId];
            
            // حفظ التغييرات في ملف adminApplications.json
            const saveResult = saveAdminApplicationSettings(settings);
            console.log(`🗑️ تم حذف الطلب ${applicationId} من المعلقة. نتيجة الحفظ: ${saveResult}`);

            // تحديث الرسالة
            const cooldownEnd = new Date(Date.now() + (settings.settings.rejectCooldownHours * 60 * 60 * 1000));
            const embed = EmbedBuilder.from(interaction.message.embeds[0])
                .setColor('#ff0000')
                .setTitle('❌ Rejected')
                .setFields([]) // مسح الحقول القديمة
                .addFields([
                    { name: '**المسؤول**', value: `<@${interaction.user.id}>`, inline: true },
                    { name: '**المرفوض**', value: `<@${candidateId}>`, inline: true },
                    { name: '**سبب الرفض**', value: reason, inline: false },
                    { name: '**الكولداون**', value: `${settings.settings.rejectCooldownHours} ساعة`, inline: true },
                    { name: '**ينتهي في**', value: `<t:${Math.floor(cooldownEnd.getTime() / 1000)}:R>`, inline: true }
                ]);

            await interaction.update({ embeds: [embed], components: [] });

            // إرسال رسالة خاصة للمرشح
            try {
                const guild = interaction.guild;
                const member = await guild.members.fetch(candidateId);
                const rejectNotificationEmbed = colorManager.createEmbed()
                    .setTitle('تم رفض تقديمك للإدارة')
                    .setDescription(`**المسؤول :** <@${interaction.user.id}>\n**السبب :** ${reason}\n\n**عليك كولداون تقديم إدارة لمدة :** ${settings.settings.rejectCooldownHours} ساعة`)
                    .setTimestamp();

                await member.send({ embeds: [rejectNotificationEmbed] });
            } catch (err) {
                console.log('فشل إرسال رسالة الرفض للعضو');
            }

            return true;
        }

        // معالجة منيو التفاصيل الإضافية
        if (customId.startsWith('admin_details_')) {
            const applicationId = customId.replace('admin_details_', '');
            const selectedDetail = interaction.values[0];

            const settings = loadAdminApplicationSettings();
            const application = settings.pendingApplications[applicationId];

            if (!application) {
                await interaction.reply({
                    content: '**❌ لم يتم العثور على طلب التقديم أو تم معالجته مسبقاً.**',
                    ephemeral: true
                });
                return true;
            }

            // التحقق من صلاحية المعتمد لعرض التفاصيل
            if (!canApproveApplication(interaction.member, settings)) {
                await interaction.reply({
                    content: '❌ **مب مسؤول؟ والله ماوريك.**',
                    ephemeral: true
                });
                return true;
            }

            const userStats = application.userStats;
            let detailEmbed;

            switch (selectedDetail) {
                case 'dates':
                    detailEmbed = colorManager.createEmbed()
                        .setTitle(` ** Dates - ${userStats.mention}**`)
                        .setThumbnail(userStats.avatar)
                        .addFields([
                            { name: '**انضمام السيرفر**', value: `**${userStats.joinedServerFormatted}**`, inline: false },
                            { name: '**إنشاء الحساب**', value: `**${userStats.accountCreatedFormatted}**`, inline: false },
                            { name: '**المدة في السيرفر**', value: `${userStats.timeInServerFormatted}`, inline: true },
                            { name: '**عمر الحساب**', value: `${userStats.accountAgeFormatted}`, inline: true },
                            { name: ' **آخر نشاط**', value: `**${userStats.lastActivity}**`, inline: true }
                        ])
;
                    break;

                case 'evaluation':
                    // تحميل إعدادات التقييم
                    const { loadEvaluationSettings, getEvaluationType } = require('../utils/userStatsCollector');
                    const evaluationSettings = loadEvaluationSettings();
                    const timeInServerDays = Math.floor(userStats.timeInServerMs / (24 * 60 * 60 * 1000));

                    // تحديد القيم المناسبة بناءً على الإعدادات
                    const messageCount = evaluationSettings.minMessages.resetWeekly ? userStats.weeklyMessages || 0 : userStats.realMessages;
                    const voiceTime = evaluationSettings.minVoiceTime.resetWeekly ? userStats.weeklyVoiceTime || 0 : userStats.realVoiceTime;
                    const reactionCount = evaluationSettings.minReactions.resetWeekly ? userStats.weeklyReactions || 0 : userStats.reactionsGiven || 0;

                    // تحديد النصوص المناسبة
                    const messageLabel = evaluationSettings.minMessages.resetWeekly ? "<:emoji:1443616698996359380> Messages : ( week )" : "<:emoji:1443616698996359380> Messages : ( All )";
                    const voiceLabel = evaluationSettings.minVoiceTime.resetWeekly ? "<:emoji:1443616700707635343> Voice : ( All )" : "<:emoji:1443616700707635343> Voice : ( All ) ";
                    const reactionLabel = evaluationSettings.minReactions.resetWeekly ? "Reactions : ( week )" : "Reactions : ( All )";

                    // تحديد التقييم العام
                    const evaluation = getEvaluationType(
                        userStats.realMessages, // إجمالي الرسائل
                        userStats.weeklyMessages || 0, // الرسائل الأسبوعية
                        userStats.realVoiceTime, // إجمالي الوقت الصوتي
                        userStats.weeklyVoiceTime || 0, // الوقت الصوتي الأسبوعي
                        userStats.reactionsGiven || 0, // إجمالي التفاعلات
                        userStats.weeklyReactions || 0, // التفاعلات الأسبوعية
                        userStats.activeDays, // أيام النشاط
                        timeInServerDays // أيام في السيرفر
                    );

                    detailEmbed = colorManager.createEmbed()
                        .setTitle(` **Evaluation**`)
                        .setThumbnail(userStats.avatar)
                        .addFields([
                            { name: ` **${messageLabel}**`, value: `**${messageCount.toLocaleString()}**`, inline: true },
                            { name: ` **${voiceLabel}**`, value: `**${evaluationSettings.minVoiceTime.resetWeekly ? userStats.formattedWeeklyVoiceTime || 'No Data' : userStats.formattedVoiceTime || 'No Data'}**`, inline: true },
                            { name: ` **${reactionLabel}**`, value: `**${reactionCount.toLocaleString()}**`, inline: true },
                            { name: ' **Active**', value: userStats.activeDays >= evaluationSettings.activeDaysPerWeek.minimum ? '🟢 **نشط**' : '🔴 **غير نشط**', inline: true },
                            { name: '  **الخبرة حسب المدة**', value: timeInServerDays >= evaluationSettings.timeInServerDays.excellent ? '🟢 **خبرة ممتازة**' : timeInServerDays >= evaluationSettings.timeInServerDays.minimum ? '🟡 **خبرة جيدة**' : '🔴 **جديد**', inline: true }
                        ])

                    break;

                case 'roles':
                    const rolesText = userStats.roles.length > 0
                        ? userStats.roles.map((role, index) => `**${index + 1}.** <@&${role.id}> (${role.name})`).join('\n')
                        : '**لا توجد رولات إضافية**';

                    detailEmbed = colorManager.createEmbed()
                        .setTitle(` ** Roles - ${userStats.mention}**`)
                        .setThumbnail(userStats.avatar)
                        .addFields([
                            { name: '**إجمالي الرولات**', value: `**${userStats.roleCount}** رول`, inline: true },
                            { name: ' **حالة الإدارة**', value: userStats.hasAdminRoles ? '✅ **لديه رولات إدارية**' : '❌ **لا يملك رولات إدارية**', inline: true },
                            { name: '**قائمة لرولات**', value: rolesText, inline: false }
                        ])

                    break;

                case 'advanced_stats':
                    detailEmbed = colorManager.createEmbed()
                        .setTitle(` ** Stats - ${userStats.mention}**`)
                        .setThumbnail(userStats.avatar)
                        .addFields([
                            { name: ' **Messages**', value: `**${userStats.realMessages.toLocaleString()}** رسالة`, inline: true },
                            { name: ' **In voice**', value: `${userStats.formattedVoiceTime}`, inline: true },
                            { name: ' **Join voice**', value: `**${userStats.joinedChannels}** `, inline: true },
                            { name: ' **Reactions**', value: `**${userStats.reactionsGiven}** `, inline: true },
                            { name: ' **Active days**', value: `**${userStats.activeDays}** `, inline: true },
                            { name: ' **Bot?**', value: userStats.isBot ? ' **بوت**' : ' **حقيقي**', inline: true }
                        ])

                    break;

                case 'simple_view':
                default:
                    // العودة للعرض البسيط مع النصوص الديناميكية
                    detailEmbed = await createUserStatsEmbed(userStats, colorManager, true, application.requesterName, application.requesterMention);
                    break;
            }

            // إنشاء الأزرار والمنيو مرة أخرى
            const approveButton = new ButtonBuilder()
                .setCustomId(`admin_approve_${applicationId}`)
                .setLabel('Approve')
.setEmoji('<:emoji_1:1436850272734285856>')
                .setStyle(ButtonStyle.Secondary);

            const rejectButton = new ButtonBuilder()
                .setCustomId(`admin_reject_modal_trigger_${applicationId}`)
                .setLabel('Reject')
.setEmoji('<:emoji_1:1436850215154880553>')
                .setStyle(ButtonStyle.Secondary);

            const detailsMenu = new StringSelectMenuBuilder()
                .setCustomId(`admin_details_${applicationId}`)
                .setPlaceholder('تفاصيل العضو')
                .addOptions([
                    {
                        label: 'Dates',
                        description: 'عرض تواريخ الانضمام وإنشاء الحساب',
                        value: 'dates',

                    },
                    {
                        label: 'evaluation',
                        description: 'عرض تقييم العضو والمعايير',
                        value: 'evaluation',

                    },
                    {
                        label: 'Roles',
                        description: 'عرض جميع رولات العضو',
                        value: 'roles',

                    },
                    {
                        label: 'Stats',
                        description: 'عرض تفاصيل النشاط للعضو',
                        value: 'advanced_stats',

                    },
                    {
                        label: 'First emp',
                        description: 'العودة للعرض الأساسي',
                        value: 'simple_view',

                    }
                ]);

            const row1 = new ActionRowBuilder()
                .addComponents(approveButton, rejectButton);

            const row2 = new ActionRowBuilder()
                .addComponents(detailsMenu);

            await interaction.update({
                embeds: [detailEmbed],
                components: [row1, row2]
            });

            return true;
        }

        // استخراج معرف الطلب
        let applicationId;
        if (customId.startsWith('admin_approve_')) {
            applicationId = customId.replace('admin_approve_', '');
        } else if (customId.startsWith('admin_reject_modal_trigger_')) {
            applicationId = customId.replace('admin_reject_modal_trigger_', '');
        } else if (customId.startsWith('admin_select_roles_')) {
            applicationId = customId.replace('admin_select_roles_', '');
        }

        console.log('معرف الطلب المستخرج:', applicationId);

        const settings = loadAdminApplicationSettings();
        console.log('الطلبات المعلقة الحالية:', Object.keys(settings.pendingApplications));

        const application = settings.pendingApplications[applicationId];

        if (!application) {
            console.log('لم يتم العثور على الطلب:', applicationId);

            await interaction.reply({
                content: '**❌ لم يتم العثور على طلب التقديم أو تم معالجته مسبقاً.**',
                ephemeral: true
            });
            return true;
        }

        console.log('تم العثور على الطلب للمرشح:', application.candidateId);

        // التحقق من صلاحية المعتمد
        if (!canApproveApplication(interaction.member, settings)) {
            await interaction.reply({
                content: '❌ ** وضعك خلني اضغط ومحد شايف ها ؟  ** ' ,        ephemeral: true
            });
            return true;
        }

        const isApproval = customId.startsWith('admin_approve_');
        const candidate = await interaction.guild.members.fetch(application.candidateId).catch(() => null);

        if (!candidate) {
            // حذف الطلب إذا كان العضو غير موجود وتحديث الرسالة
            delete settings.pendingApplications[applicationId];
            saveAdminApplicationSettings(settings);

            const errorEmbed = colorManager.createEmbed()
                .setTitle('❌ خطأ')
                .setDescription('**لم يتم العثور على العضو في السيرفر. تم حذف الطلب.**')
                .setTimestamp();

            await interaction.update({
                embeds: [errorEmbed],
                components: []
            });

            return true;
        }

        if (isApproval) {
            // معالجة الموافقة - استخدام الرولات المحددة مسبقاً
            await interaction.deferReply({ ephemeral: true });

            const adminRolesToGrant = settings.settings.adminRolesToGrant || [];

            if (adminRolesToGrant.length === 0) {
                await interaction.editReply({
                    content: '**❌ لم يتم تحديد رولات إدارية لإعطائها. استخدم أمر `setadmin` لتحديد الرولات أولاً.**'
                });
                return true;
            }

            // فلترة الرولات الصحيحة وإضافتها
            let addedRoles = [];
            let failedRoles = [];

            for (const roleId of adminRolesToGrant) {
                try {
                    const role = interaction.guild.roles.cache.get(roleId);
                    if (!role) {
                        failedRoles.push(`رول ${roleId} (محذوف)`);
                        continue;
                    }

                    if (candidate.roles.cache.has(roleId)) {
                        console.log(`⚠️ المرشح ${candidate.displayName} لديه بالفعل الدور: ${role.name}`);
                        continue;
                    }

                    if (typeof global.markAdminRoleGrant === 'function') {
                        global.markAdminRoleGrant(interaction.guild.id, candidate.id, roleId);
                    }

                    await candidate.roles.add(roleId, `موافقة على طلب التقديم الإداري - بواسطة ${interaction.user.tag}`);
                    addedRoles.push({ id: roleId, name: role.name });
                    console.log(`✅ تم إضافة الدور ${role.name} للمرشح ${candidate.displayName}`);

                    // إزالة التقييد عند القبول (في حال كان مرفوضاً سابقاً)
                    if (settings.rejectedCooldowns && settings.rejectedCooldowns[application.candidateId]) {
                        delete settings.rejectedCooldowns[application.candidateId];
                        saveAdminApplicationSettings(settings);
                    }

                    // تأخير بسيط بين إضافة الأدوار لتجنب rate limiting
                    if (adminRolesToGrant.length > 1) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                } catch (roleError) {
                    console.error(`❌ فشل في إضافة الدور ${roleId}:`, roleError);
                    const role = interaction.guild.roles.cache.get(roleId);
                    failedRoles.push(role ? role.name : `دور ${roleId}`);
                }
            }

            // تحديث الرسالة الأصلية
            const approvedEmbed = colorManager.createEmbed()
                .setTitle('✅ Accepted')
                .setDescription(`**By : <@${interaction.user.id}>\nNew Admin : <@${application.candidateId}> **`)
                .addFields([
                    { 
                        name: '**Added role**', 
                        value: addedRoles.length > 0 ? addedRoles.map(r => r.name).slice(0, 5).join(', ') : 'لا يوجد', 
                        inline: false 
                    },
                    { 
                        name: '**Date**', 
                        value: moment().tz('Asia/Riyadh').format('YYYY-MM-DD HH:mm'), 
                        inline: true 
                    }
                ])
                .setTimestamp();

            if (failedRoles.length > 0) {
                approvedEmbed.addFields([
                    { name: 'ملاحظات', value: `فشل في إضافة : ${failedRoles.join(', ')}`, inline: false }
                ]);
            }

            await interaction.message.edit({
                embeds: [approvedEmbed],
                components: []
            });

            // إرسال إشعار للمرشح
            if (addedRoles.length > 0) {
                try {
                    const notificationEmbed = colorManager.createEmbed()
                        .setTitle('تم قبول طلبك للإدارة')
                        .setDescription(`**قبلك مسؤول الإدارة :** <@${interaction.user.id}>\n\n**رولك الذي عُطي :** ${addedRoles.map(r => r.name).join(', ')}\n\n**تاريخ الموافقة :** ${moment().tz('Asia/Riyadh').format('YYYY-MM-DD HH:mm')}`)
                        .setTimestamp();

                    notificationEmbed.addFields([
                        { name: '**الرولات الإدارية الجديدة**', value: `**${addedRoles.map(r => `\`${r.name}\``).join(' • ')}**`, inline: false },
                        { name: '**تذكير مهم**', value: 'راجع روم القوانين وكل المعلومات التي تحتاجها كإداري', inline: false }
                    ]);

                    await candidate.user.send({ embeds: [notificationEmbed] });
                    console.log(`📧 تم إرسال إشعار مفصل للمرشح <@${application.candidateId}>`);
                } catch (dmError) {
                    console.log(`⚠️ تعذر إرسال إشعار خاص للمرشح <@${application.candidateId}>:`, dmError.message);
                }

                // حذف الطلب من الطلبات المعلقة
                delete settings.pendingApplications[applicationId];
                const saveResult = saveAdminApplicationSettings(settings);

                await interaction.editReply({
                    content: `✅ تمت الموافقة على <@${application.candidateId}> بنجاح!\n**الرولات المضافة :** ${addedRoles.map(r => r.name).join(', ')}`
                });

                console.log(`✅ تمت الموافقة على طلب إداري: ${application.candidateId} (<@${application.candidateId}>) بواسطة ${interaction.user.id} - أدوار مضافة: ${addedRoles.length}`);
            } else {
                await interaction.editReply({
                    content: '❌ فشلت جميع الأدوار في الإضافة. تحقق من صلاحيات البوت وترتيب الرولات.'
                });
            }

            return true;

        } else {
            // معالجة الرفض القديمة - تم تعطيلها لصالح نظام المودال الجديد
            return true;
        }

        return true;

    } catch (error) {
        console.error('خطأ في معالجة تفاعل التقديم الإداري:', error);

        try {
            const errorMessage = 'حدث خطأ في معالجة طلب التقديم. حاول مرة أخرى.';
            if (interaction.deferred) {
                await interaction.editReply({ content: errorMessage });
            } else {
                await interaction.reply({ content: errorMessage });
            }
        } catch (replyError) {
            console.error('خطأ في الرد على التفاعل:', replyError);
        }

        return true;
    }
}

module.exports.handleAdminApplicationInteraction = handleAdminApplicationInteraction;
