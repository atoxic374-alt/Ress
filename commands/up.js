const { 
    ActionRowBuilder, 
    StringSelectMenuBuilder, 
    MessageFlags,
    ComponentType,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const colorManager = require('../utils/colorManager');
const promoteManager = require('../utils/promoteManager');
const { getQuickPromotionTypes, resolveQuickPromotion } = require('../utils/quickPromotionResolver');
const { getRealUserStats } = require('../utils/userStatsCollector');
const fs = require('fs');
const path = require('path');

// ذاكرة مؤقتة للرولات الإدارية لتقليل عمليات البحث المتكررة
let cachedAdminRoles = null;
let lastCacheUpdate = 0;

// تتبع العمليات النشطة لتجنب التداخل
const activeOperations = new Set(); // تتبع المسؤولين النشطين
const lockedMembers = new Set();    // تتبع الأعضاء الجاري ترقيتهم/تنزيلهم لمنع التداخل
const recentPromotions = new Map();

// دالة تحويل الملي ثانية إلى تنسيق مقروء
function formatTime(ms) {
    if (!ms || ms <= 0) return '0m';
    const totalMinutes = Math.floor(ms / 60000);
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const minutes = totalMinutes % 60;

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    return parts.length > 0 ? parts.join(' , ') : '0m';
}

async function getSortedAdminRoles(guild) {
    const now = Date.now();
    if (!cachedAdminRoles || (now - lastCacheUpdate) > 600000) {
        const adminRolesList = promoteManager.getAdminRoles();
        cachedAdminRoles = adminRolesList
            .map(id => guild.roles.cache.get(id))
            .filter(r => r)
            .sort((a, b) => a.position - b.position);
        lastCacheUpdate = now;
    }
    return cachedAdminRoles;
}

module.exports = {
    name: 'ترقيه',
    description: 'Shortcut for promotion/demotion (ترقية/تنزيل سريع)',
    async execute(message, args, context) {
        const { client, BOT_OWNERS } = context;

        if (activeOperations.has(message.author.id)) {
            return message.reply({ content: '**⚠️ لديك عملية قيد التنفيذ حالياً ، يرجى الانتظار .**', flags: MessageFlags.Ephemeral });
        }

        let hasPermission = await promoteManager.hasPermission({ 
            user: message.author, 
            member: message.member 
        }, BOT_OWNERS);

        if (!hasPermission) {
            const settings = promoteManager.getSettings();
            const permissionType = settings.allowedUsers?.type;

            if (permissionType === 'owners') {
                hasPermission = BOT_OWNERS.includes(message.author.id);
            } else if (permissionType === 'roles') {
                hasPermission = message.member.roles.cache.some(role => settings.allowedUsers.targets.includes(role.id));
            } else if (permissionType === 'responsibility') {
                const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
                const responsibilities = fs.existsSync(responsibilitiesPath)
                    ? JSON.parse(fs.readFileSync(responsibilitiesPath, 'utf8'))
                    : {};
                hasPermission = settings.allowedUsers.targets.some((respName) => {
                    const respData = responsibilities[respName];
                    return respData?.responsibles?.includes(message.author.id);
                });
            }
        }

        if (!hasPermission) {
            return message.reply({ content: '**❌ ليس لديك صلاحية لاستخدام هذا الأمر .**', flags: MessageFlags.Ephemeral });
        }

        const targets = message.mentions.members.filter(m => !m.user.bot);
        if (targets.size === 0) return message.reply('**❌ يرجى منشن إداري واحد على الأقل .**');

        // التحقق من تداخل العمليات على الأعضاء المستهدفين
        const lockedTargets = targets.filter(m => lockedMembers.has(m.id));
        if (lockedTargets.size > 0) {
            return message.reply(`**⚠️ الأعضاء التاليين قيد المعالجة حالياً في عملية أخرى: ${lockedTargets.map(m => m.toString()).join(' , ')}**`);
        }

        const adminRolesListIds = promoteManager.getAdminRoles();
        const nonAdmins = targets.filter(m => !m.roles.cache.some(r => adminRolesListIds.includes(r.id)));
        if (nonAdmins.size > 0) return message.reply(`**❌ الأعضاء التاليين ليسوا إداريين : ${nonAdmins.map(m => m.toString()).join(' , ')}**`);

        const botMember = await message.guild.members.fetch(client.user.id);
        if (!botMember.permissions.has('ManageRoles')) {
            return message.reply('**❌ البوت لا يملك صلاحية إدارة الرتب في هذا السيرفر .**');
        }

        const embed = colorManager.createEmbed()
            .setTitle('نظام الترقية والتنزيل السريع')
            .setDescription(`** سيتم التعامل مع ${targets.size} إداري . راجع إحصائياتهم سريعا :**`)
            .setThumbnail(client.user.displayAvatarURL())
            .setTimestamp();

        for (const [id, target] of targets) {
            try {
                const s = await getRealUserStats(target.id);
                const voiceTimeFormatted = formatTime(s.voiceTime || 0);
                const statsText = `رسائل : **${s.messages || 0}** | صوتي : **${voiceTimeFormatted}** | نشاط : **${s.activeDays || 0} يوم**`;
                embed.addFields({ name: `إداري : ${target.displayName}`, value: statsText });
            } catch (e) {
                embed.addFields({ name: `إداري : ${target.displayName}`, value: 'بيانات غير متاحة حالياً' });
            }
        }

        // الخطوة 1: اختيار نوع العملية (ترقية أو تنزيل)
        const mainRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('action_up').setLabel('ترقية').setStyle(ButtonStyle.Success).setEmoji('🔼'),
            new ButtonBuilder().setCustomId('action_down').setLabel('تنزيل').setStyle(ButtonStyle.Danger).setEmoji('🔽')
        );

        const reply = await message.reply({ embeds: [embed], components: [mainRow] });
        activeOperations.add(message.author.id);

        const collector = reply.createMessageComponentCollector({ 
            filter: i => i.user.id === message.author.id, 
            time: 60000 
        });

        let selectedAction = null; // 'up' or 'down'
        let selectedType = null;   // 'rank', 'visual', or 'both'
        let selectedLevels = 0;

        collector.on('collect', async (interaction) => {
            if (interaction.customId === 'action_up' || interaction.customId === 'action_down') {
                selectedAction = interaction.customId === 'action_up' ? 'up' : 'down';
                
                const typeEmbed = colorManager.createEmbed()
                    .setTitle(selectedAction === 'up' ? 'تحديد نوع الترقية' : 'تحديد نوع التنزيل')
                    .setDescription(`**لقد اخترت عملية: ___${selectedAction === 'up' ? 'ترقية' : 'تنزيل'}___\nالآن اختر نوع الرتب المطلوب التعامل معها:**`);

                const typeMenu = new StringSelectMenuBuilder()
                    .setCustomId('select_type')
                    .setPlaceholder('اختر النوع...')
                    .addOptions([
                        { label: 'رتب الحرف (Rank)', value: 'rank', description: 'التعامل مع رولات (A , B , C ...)' },
                        { label: 'رتب ظاهرية (Visual)', value: 'visual', description: 'التعامل مع رولات الأسماء والظواهر' },
                        { label: 'الاثنين (حرف + ظاهرية)', value: 'both', description: 'ترقية أو تنزيل النوعين كلٌ على حدة' }
                    ]);

                await interaction.update({ embeds: [typeEmbed], components: [new ActionRowBuilder().addComponents(typeMenu)] });
            }

            else if (interaction.customId === 'select_type') {
                selectedType = interaction.values[0];
                
                const levelEmbed = colorManager.createEmbed()
                    .setTitle('تحديد عدد الترقيات')
                    .setDescription(`**العملية: ___${selectedAction === 'up' ? 'ترقية' : 'تنزيل'} (${selectedType === 'rank' ? 'حرف' : selectedType === 'visual' ? 'ظواهر' : 'حرف + ظواهر'})___\nاختر عدد المستويات التي تريد تنفيذها لكل نوع :**`);

                const levelRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('level_1').setLabel('1').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('level_2').setLabel('2').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('level_3').setLabel('3').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('level_4').setLabel('4').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('level_5').setLabel('5').setStyle(ButtonStyle.Primary)
                );

                await interaction.update({ embeds: [levelEmbed], components: [levelRow] });
            }

            else if (interaction.customId.startsWith('level_')) {
                selectedLevels = parseInt(interaction.customId.split('_')[1]);
                // قفل الأعضاء لمنع التداخل
                targets.forEach(m => lockedMembers.add(m.id));

                const processingEmbed = colorManager.createEmbed()
                    .setTitle('جاري تنفيذ العملية ...')
                    .setDescription(`يتم الآن معالجة **${selectedAction === 'up' ? 'ترقية' : 'تنزيل'}** **${targets.size}** إداري بمقدار **${selectedLevels}** مستوى لكل نوع محدد (${selectedType === 'both' ? 'الحرف والظاهرية بشكل مستقل' : selectedType === 'rank' ? 'الحرف' : 'الظاهرية'}).\nيرجى الانتظار ثوانٍ معدودة ...`);
                    
                await interaction.update({ embeds: [processingEmbed], components: [] });

                const promotionDetails = { rank: [], visual: [] };
                const undoData = [];
                
                const sortedAdminRoles = await getSortedAdminRoles(message.guild);

                const promoPromises = targets.map(async (target) => {
                    try {
                        const memberOutcome = [];
                        const initialRoles = [...target.roles.cache.values()];
                        const typePlan = getQuickPromotionTypes(initialRoles, adminRolesListIds, selectedType);

                        if (typePlan.types.length === 0) {
                            return [`❌ **${target.displayName}**: لا يملك رتبة حرف أو ظاهرية مسجلة.`];
                        }
                        if (selectedType === 'both' && typePlan.missingTypes.length > 0) {
                            const missingNames = typePlan.missingTypes.map(type => type === 'rank' ? 'الحرف' : 'الظاهرية').join(' و');
                            memberOutcome.push(`⚠️ **${target.displayName}**: لا يملك رتبة ${missingNames}، تم تخطي هذا المسار.`);
                        }

                        // كل نوع عملية مستقلة؛ فشل إحداها لا يمنع تنفيذ النوع الآخر.
                        for (const type of typePlan.types) {
                            const member = await message.guild.members.fetch({ user: target.id, force: true }).catch(() => target);
                            const memberRoles = [...member.roles.cache.values()];
                            const typeName = type === 'rank' ? 'حرف' : 'ظاهرية';
                            const availableRoles = sortedAdminRoles.filter(role =>
                                (role.name.length <= 3) === (type === 'rank')
                            );
                            const resolution = resolveQuickPromotion({
                                memberRoles,
                                adminRoleIds: adminRolesListIds,
                                availableRoles,
                                selectedType: type,
                                selectedAction,
                                levels: selectedLevels
                            });

                            if (resolution.error === 'no-current-role') {
                                memberOutcome.push(`❌ **${target.displayName} — ${typeName}**: لا يملك رتبًا إدارية مناسبة لهذا المسار.`);
                                continue;
                            }
                            if (resolution.error === 'out-of-range') {
                                memberOutcome.push(`⚠️ **${target.displayName} — ${typeName}**: وصل إلى الحد الأقصى/الأدنى.`);
                                continue;
                            }

                            const { currentRole, newRole, rolesToRemove } = resolution;
                            const res = await promoteManager.createPromotion(
                                message.guild, client, target.id, newRole.id,
                                'نهائي', `Shortcut ${selectedAction.toUpperCase()} (${typeName})`,
                                message.author.id, false, true, true
                            );

                            if (!res.success) {
                                memberOutcome.push(`❌ **${target.displayName} — ${typeName}**: فشل (${res.error}).`);
                                continue;
                            }

                            // إزالة رتبة المصدر عند التحويل، مع المحافظة على النوع الآخر
                            // الذي يملكه العضو عند تشغيل المسارين معًا.
                            for (const oldRoleId of rolesToRemove) {
                                if (oldRoleId === newRole.id) continue;
                                const currentMember = await message.guild.members.fetch({ user: target.id, force: true }).catch(() => member);
                                if (currentMember.roles.cache.has(oldRoleId)) {
                                    await currentMember.roles.remove(oldRoleId, 'استبدال رتبة النوع المختار في الترقية السريعة').catch(() => {});
                                }
                            }

                            promotionDetails[type].push(`• ${target} — ${currentRole.name} ← ${newRole.name}`);
                            undoData.push({
                                memberId: target.id,
                                addedRoleId: newRole.id,
                                removedRoleIds: rolesToRemove
                            });
                            memberOutcome.push(`✅ **${target.displayName} — ${typeName}**: ${selectedAction === 'up' ? 'تمت ترقيته' : 'تم تنزيله'} من **${currentRole.name}** إلى **${newRole.name}**.`);

                            try {
                                await target.send(`**✅ تم ${selectedAction === 'up' ? 'ترقيتك' : 'تنزيلك'} (${typeName}) في ${message.guild.name}: ${currentRole.name} ← ${newRole.name}**`).catch(() => {});
                            } catch (e) {}
                        }
                        return memberOutcome;
                    } catch (e) { 
                        return [`❌ **${target.displayName}**: حدث خطأ غير متوقع أثناء المعالجة.`];
                    } finally {
                        lockedMembers.delete(target.id); // فك القفل بعد الانتهاء
                    }
                });

                const outcome = (await Promise.all(promoPromises)).flat();
                activeOperations.delete(message.author.id);

                const settings = promoteManager.getSettings();
                const hasPromotionDetails = promotionDetails.rank.length > 0 || promotionDetails.visual.length > 0;
                if (settings.logChannel && hasPromotionDetails) {
                    const logChannel = client.channels.cache.get(settings.logChannel);
                    if (logChannel) {
                        const logEmbed = colorManager.createEmbed()
                            .setTitle(selectedAction === 'up' ? 'سجل الترقية السريعة' : 'سجل التنزيل السريع')
                            .setDescription(`تم تنفيذ الطلب بواسطة ${message.author}؛ كل نوع عولج بشكل مستقل.`)
                            .setTimestamp();

                        const fields = [
                            { name: 'المسؤول', value: `${message.author}`, inline: true },
                            { name: 'الإجراء', value: selectedAction === 'up' ? 'ترقية' : 'تنزيل', inline: true },
                            { name: 'المستويات لكل مسار', value: `${selectedLevels}`, inline: true },
                            { name: 'التاريخ', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
                        ];

                        for (const [type, title] of [['rank', 'الحرف'], ['visual', 'الظاهرية']]) {
                            const entries = promotionDetails[type];
                            if (!entries.length) continue;
                            let part = 1;
                            let current = '';
                            for (const line of entries.slice(0, 12)) {
                                if (current && current.length + line.length + 1 > 950) {
                                    fields.push({ name: part === 1 ? `نتائج ${title}` : `نتائج ${title} (${part})`, value: current, inline: false });
                                    current = '';
                                    part++;
                                }
                                current += `${current ? '\n' : ''}${line}`;
                            }
                            if (entries.length > 12) current += `\n… و${entries.length - 12} عملية أخرى`;
                            if (current) fields.push({ name: part === 1 ? `نتائج ${title}` : `نتائج ${title} (${part})`, value: current, inline: false });
                        }
                        logEmbed.addFields(fields);

                        await logChannel.send({ embeds: [logEmbed] }).catch(() => {});
                    }
                }

                const undoId = `undo_${Date.now()}`;
                if (undoData.length > 0) {
                    recentPromotions.set(undoId, undoData);
                    setTimeout(() => recentPromotions.delete(undoId), 60000);
                }

                const successCount = outcome.filter((line) => line.startsWith('✅')).length;
                const failedCount = outcome.filter((line) => line.startsWith('❌')).length;
                const skippedCount = outcome.filter((line) => line.startsWith('⚠️')).length;

                let statusTitle = 'اكتملت معالجة الطلبات';
                let statusLine = 'تم الانتهاء من معالجة جميع الطلبات.';

                if (successCount === 0 && (failedCount > 0 || skippedCount > 0)) {
                    statusTitle = 'انتهت المعالجة بدون نجاح';
                    statusLine = 'تمت المحاولة ولكن لم تنجح أي عملية.';
                } else if (failedCount > 0 || skippedCount > 0) {
                    statusTitle = 'اكتملت المعالجة (نتيجة جزئية)';
                    statusLine = 'تمت معالجة الطلبات مع وجود بعض العمليات غير المكتملة.';
                }

                const finalResultEmbed = colorManager.createEmbed()
                    .setTitle(statusTitle)
                    .setDescription(
                        `${statusLine}\n` +
                        `**ملخص العمليات:** ✅ ${successCount} | ❌ ${failedCount} | ⚠️ ${skippedCount}\n` +
                        `**الاختيار:** ${selectedType === 'both' ? 'الحرف والظاهرية، كل مسار مستقل' : selectedType === 'rank' ? 'الحرف' : 'الظاهرية'} × ${selectedLevels} مستوى`
                    )
                    .setFooter({ text: undoData.length ? 'يمكنك التراجع عن العمليات الناجحة خلال دقيقة واحدة.' : 'انتهت المعالجة.' });

                const resultGroups = [
                    ['الحرف', outcome.filter(line => line.includes('— حرف'))],
                    ['الظاهرية', outcome.filter(line => line.includes('— ظاهرية'))],
                    ['ملاحظات أخرى', outcome.filter(line => !line.includes('— حرف') && !line.includes('— ظاهرية'))]
                ];
                let remainingResultChars = 4700;
                for (const [groupTitle, lines] of resultGroups) {
                    if (!lines.length || remainingResultChars <= 0) continue;
                    const fieldsForGroup = [];
                    let current = '';
                    let part = 1;
                    for (const line of lines) {
                        const remainingLines = lines.length - fieldsForGroup.reduce((sum, field) => sum + field.lineCount, 0);
                        if (fieldsForGroup.length >= 2 || remainingResultChars <= 0) break;
                        const safeLine = line.length > Math.min(900, remainingResultChars)
                            ? `${line.slice(0, Math.max(0, Math.min(900, remainingResultChars) - 1))}…`
                            : line;
                        if (current && current.length + safeLine.length + 1 > Math.min(900, remainingResultChars)) {
                            fieldsForGroup.push({ name: part === 1 ? `نتائج ${groupTitle}` : `نتائج ${groupTitle} (${part})`, value: current, lineCount: current.split('\n').length });
                            remainingResultChars -= current.length;
                            current = '';
                            part++;
                            if (fieldsForGroup.length >= 2 || remainingResultChars <= 0) break;
                        }
                        current += `${current ? '\n' : ''}${safeLine}`;
                        if (remainingLines <= 1) break;
                    }
                    if (current && fieldsForGroup.length < 2) {
                        fieldsForGroup.push({ name: part === 1 ? `نتائج ${groupTitle}` : `نتائج ${groupTitle} (${part})`, value: current, lineCount: current.split('\n').length });
                        remainingResultChars -= current.length;
                    }
                    const shownLines = fieldsForGroup.reduce((sum, field) => sum + field.lineCount, 0);
                    for (const field of fieldsForGroup) finalResultEmbed.addFields({ name: field.name, value: field.value, inline: false });
                    if (shownLines < lines.length && remainingResultChars > 100) {
                        const note = `… تمت معالجة ${lines.length - shownLines} نتيجة إضافية.`;
                        finalResultEmbed.addFields({ name: `بقية ${groupTitle}`, value: note, inline: false });
                        remainingResultChars -= note.length;
                    }
                }

                const undoButton = new ButtonBuilder()
                    .setCustomId(undoId)
                    .setLabel('تراجع عن الكل (Undo)')
                    .setEmoji('↩️')
                    .setStyle(ButtonStyle.Danger);

                await reply.edit({ 
                    embeds: [finalResultEmbed],
                    components: undoData.length > 0 ? [new ActionRowBuilder().addComponents(undoButton)] : []
                });

                if (undoData.length > 0) {
                    const undoCollector = reply.createMessageComponentCollector({
                        filter: i => i.user.id === message.author.id && i.customId === undoId,
                        time: 60000,
                        max: 1
                    });

                    undoCollector.on('collect', async (undoInteraction) => {
                        const data = recentPromotions.get(undoId);
                        if (!data) return undoInteraction.reply({ content: '**❌ انتهت صلاحية التراجع .**', flags: MessageFlags.Ephemeral });

                        const undoPromises = data.map(async (item) => {
                            try {
                                const member = await message.guild.members.fetch(item.memberId).catch(() => null);
                                if (member) {
                                    await member.roles.remove(item.addedRoleId, 'تراجع عن عملية سريعة').catch(() => {});
                                    for (const oldId of item.removedRoleIds) {
                                        await member.roles.add(oldId, 'إعادة الرتبة بعد التراجع').catch(() => {});
                                    }
                                }
                            } catch (e) { console.error(e); }
                        });

                        await Promise.all(undoPromises);

                        const undoneEmbed = colorManager.createEmbed()
                            .setTitle('تم التراجع بالكامل')
                            .setDescription('**تم إلغاء التغييرات وإعادة الرتب السابقة لجميع الإداريين بنجاح .**')
                            .setTimestamp();
                        
                        await reply.edit({ embeds: [undoneEmbed], components: [] });
                        recentPromotions.delete(undoId);
                    });

                    undoCollector.on('end', (_, reason) => {
                        if (reason === 'time') reply.edit({ components: [] }).catch(() => {});
                    });
                }
                collector.stop();
            }
        });

        collector.on('end', (_, reason) => {
            activeOperations.delete(message.author.id);
            if (reason === 'time') {
                reply.edit({ components: [] }).catch(() => {});
            }
        });
    }
};
