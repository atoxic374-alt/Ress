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
        let selectedType = null;   // 'rank' or 'visual'
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
                        { label: 'رتب ظاهرية (Visual)', value: 'visual', description: 'التعامل مع رولات الأسماء والظواهر' }
                    ]);

                await interaction.update({ embeds: [typeEmbed], components: [new ActionRowBuilder().addComponents(typeMenu)] });
            }

            else if (interaction.customId === 'select_type') {
                selectedType = interaction.values[0];
                
                const levelEmbed = colorManager.createEmbed()
                    .setTitle('تحديد عدد الترقيات')
                    .setDescription(`**العملية: ___${selectedAction === 'up' ? 'ترقية' : 'تنزيل'} (${selectedType === 'rank' ? 'حرف' : 'ظواهر'})___\nاختر عدد لترقيات التي تريد تنفيذها :**`);

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
                const finalLevels = selectedAction === 'up' ? selectedLevels : -selectedLevels;

                // قفل الأعضاء لمنع التداخل
                targets.forEach(m => lockedMembers.add(m.id));

                const processingEmbed = colorManager.createEmbed()
                    .setTitle('جاري تنفيذ العملية ...')
                    .setDescription(`يتم الآن معالجة **${selectedAction === 'up' ? 'ترقية' : 'تنزيل'}** عدد **${targets.size}** إداري بمقدار **${selectedLevels}** مستويات .\nيرجى الانتظار ثوانٍ معدودة ...`);
                    
                await interaction.update({ embeds: [processingEmbed], components: [] });

                const results = [];
                const promotionDetails = [];
                const undoData = [];
                
                const sortedAdminRoles = await getSortedAdminRoles(message.guild);
                const filterTypeRank = selectedType === 'rank';
                const availableRoles = sortedAdminRoles.filter(r => (r.name.length <= 3) === filterTypeRank);

                const promoPromises = targets.map(async (target) => {
                    try {
                        // البحث عن أعلى رتبة يملكها العضو من النوع المختار فقط (حرف أو ظواهر)
                        const currentRole = target.roles.cache
                            .filter(r => adminRolesListIds.includes(r.id) && (r.name.length <= 3) === filterTypeRank)
                            .sort((a, b) => b.position - a.position)
                            .first();

                        if (!currentRole) return `**❌ ${target.displayName} : لا يملك رول إداري .**`;

                        const currentIndex = availableRoles.findIndex(r => r.id === currentRole.id);
                        const targetIndex = currentIndex === -1 ? 
                            availableRoles.findIndex(r => r.position > currentRole.position) + (finalLevels - (selectedAction === 'up' ? 1 : 0)) : 
                            currentIndex + finalLevels;

                        if (targetIndex < 0 || targetIndex >= availableRoles.length) {
                            return `**⚠️ ${target.displayName} : وصل للحد الأقصى/الأدنى .**`;
                        }

                        const newRole = availableRoles[targetIndex];
                        
                        const rolesToRemoveBeforePromotion = target.roles.cache
                            .filter(r => adminRolesListIds.includes(r.id) && (r.name.length <= 3) === (newRole.name.length <= 3))
                            .map(r => r.id);

                        const res = await promoteManager.createPromotion(
                            message.guild, client, target.id, newRole.id, 
                            'نهائي', `Shortcut ${selectedAction.toUpperCase()}`, 
                            message.author.id, false, true, true
                        );

                        if (res.success) {
                            promotionDetails.push(`**الإداري : ${target} - من الرول : ${currentRole} - الى الرول : ${newRole}**`);
                            undoData.push({ 
                                memberId: target.id, 
                                addedRoleId: newRole.id,
                                removedRoleIds: rolesToRemoveBeforePromotion 
                            });

                            // إرسال إشعار DM للعضو (استخدام الاسم بدلاً من المنشن لتجنب Unknown Role)
                            try {
                                await target.send(`** ✅ تم ${selectedAction === 'up' ? 'ترقيتك' : 'تنزيلك'} بسيرفر : ${message.guild.name}\n من الرتبة : ${currentRole.name} الى الرتبة : ${newRole.name} **`).catch(() => {});
                            } catch (e) {}

                            return `✅ **${target.displayName}** : تمت ${selectedAction === 'up' ? 'ترقيته' : 'تنزيله'} بنجاح إلى ${newRole}`;
                        }
                        return `❌ **${target.displayName}** : فشل ( ${res.error} )`;
                    } catch (e) { 
                        return `❌ **${target.displayName}** : حدث خطأ غير متوقع .`; 
                    } finally {
                        lockedMembers.delete(target.id); // فك القفل بعد الانتهاء
                    }
                });

                const outcome = await Promise.all(promoPromises);
                activeOperations.delete(message.author.id);

                const settings = promoteManager.getSettings();
                if (settings.logChannel && promotionDetails.length > 0) {
                    const logChannel = client.channels.cache.get(settings.logChannel);
                    if (logChannel) {
                        // Build the base embed with static fields
                        const logEmbed = colorManager.createEmbed()
                            .setTitle(selectedAction === 'up' ? '✅️ Promoted Successfully' : '🔽 Demoted Successfully')
                            .setTimestamp();

                        // Prepare the list of field objects to add. Start with the static ones.
                        const fields = [];
                        fields.push({ name: 'المسؤول المنفذ', value: `${message.author}`, inline: true });
                        fields.push({ name: 'عدد الترقيات', value: `**${selectedLevels}**`, inline: true });
                        fields.push({ name: 'نوع العملية', value: `**${selectedAction === 'up' ? 'ترقية' : 'تنزيل'} (${selectedType === 'rank' ? 'حرف' : 'ظواهر'})**`, inline: true });
                        // We'll add the affected members list later and timestamp after
                        fields.push({ name: 'التاريخ', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true });

                        // Build the affected members string(s) ensuring each does not exceed Discord's 1024 character per field limit.
                        const maxFieldLength = 1024;
                        const lines = promotionDetails.slice(0, 10); // limit to first 10 affected entries in logs
                        if (promotionDetails.length > 10) {
                            lines.push(`\n*... وغيرهم ( ${promotionDetails.length - 10} آخرين )*`);
                        }
                        let current = '';
                        let part = 1;
                        lines.forEach((line, idx) => {
                            // Determine if adding this line would exceed the max length
                            // +1 for a newline when needed
                            const newLen = current.length + (current.length ? 1 : 0) + line.length;
                            if (newLen > maxFieldLength) {
                                // Push the current chunk and start a new one
                                fields.push({ name: part === 1 ? 'المتأثرين' : `المتأثرين (جزء ${part})`, value: current });
                                part++;
                                current = line;
                            } else {
                                current += (current.length ? '\n' : '') + line;
                            }
                        });
                        if (current) {
                            fields.push({ name: part === 1 ? 'المتأثرين' : `المتأثرين (جزء ${part})`, value: current });
                        }
                        // Add the built fields to the embed in chunks of 25 to respect Discord's field limits
                        // (There are only a few fields expected here, but we stay safe.)
                        // Discord allows up to 25 fields per embed. We send only one embed.
                        logEmbed.addFields(fields);

                        await logChannel.send({ embeds: [logEmbed] }).catch(() => {});
                    }
                }

                const undoId = `undo_${Date.now()}`;
                if (undoData.length > 0) {
                    recentPromotions.set(undoId, undoData);
                    setTimeout(() => recentPromotions.delete(undoId), 60000);
                }

                const finalResultEmbed = colorManager.createEmbed()
                    .setTitle('اكتملت العملية بنجاح')
                    .setDescription(`تم الانتهاء من معالجة جميع الطلبات .\n\n**النتائج :**\n${outcome.join('\n')}`)
                    .setFooter({ text: 'يمكنك التراجع عن هذه العملية بالكامل خلال دقيقة واحدة .' });

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
