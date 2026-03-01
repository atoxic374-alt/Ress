
const { EmbedBuilder, StringSelectMenuBuilder, ActionRowBuilder } = require('discord.js');

const colorManager = require('../utils/colorManager.js');

const { isUserBlocked } = require('./block.js');

const fs = require('fs');

const path = require('path');

const DATA_FILES = {
    categories: path.join(__dirname, '..', 'data', 'respCategories.json')
};

module.exports = {

    name: 'مسؤولياتي',

    aliases: ['مسؤولياتي', 'مسؤولتي'],

    description: 'تقديم شخص للحصول على صلاحيات إدارية',

    async execute(message, args, { responsibilities, client, BOT_OWNERS, ADMIN_ROLES }) {

        // فحص البلوك أولاً

        if (isUserBlocked(message.author.id)) {

            const blockedEmbed = colorManager.createEmbed()

                .setDescription('**أنت محظور من استخدام أوامر البوت**\n**للاستفسار، تواصل مع إدارة السيرفر**')

                .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

            await message.channel.send({ embeds: [blockedEmbed] });

            return;

        }

        const member = await message.guild.members.fetch(message.author.id);

        const hasAdminRole = ADMIN_ROLES && ADMIN_ROLES.length > 0 && member.roles.cache.some(role => ADMIN_ROLES.includes(role.id));

        const hasAdministrator = member.permissions.has('Administrator');

        const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;

        if (!hasAdminRole && !isOwner && !hasAdministrator) {

            await message.react('❌');

            return;

        }

        // التحقق من وجود منشن

        let targetUser = message.mentions.users.first();

        

        if (!targetUser && args[0]) {

            // محاولة جلب المستخدم عن طريق الآي دي إذا لم يكن هناك منشن

            const userIdArg = args[0].replace(/[<@!>]/g, '');

            if (/^\d{17,19}$/.test(userIdArg)) {

                targetUser = await client.users.fetch(userIdArg).catch(() => null);

            }

        }

        if (!targetUser) targetUser = message.author;
        let userId = targetUser.id;

        // تحميل المسؤوليات الحديثة من الكائن العالمي أو SQLite
        let currentResponsibilities = global.responsibilities;
        if (!currentResponsibilities || Object.keys(currentResponsibilities).length === 0) {
            try {
                const database = require('../utils/database');
                const dbManager = database.getDatabase ? database.getDatabase() : database.dbManager;
                currentResponsibilities = await dbManager.getResponsibilities();
                global.responsibilities = currentResponsibilities;
            } catch (error) {
                console.error('خطأ في جلب المسؤوليات:', error);
                currentResponsibilities = {};
            }
        }

        // دالة للبحث عن قسم المسؤولية
        const categories = fs.existsSync(DATA_FILES.categories) ? JSON.parse(fs.readFileSync(DATA_FILES.categories, 'utf8')) : {};
        function findCategoryForResp(respName) {
            for (const [catName, catData] of Object.entries(categories)) {
                if (catData.responsibilities && catData.responsibilities.includes(respName)) {
                    return catName;
                }
            }
            return null;
        }

        // البحث عن مسؤوليات المستخدم المحدد

        const userResponsibilities = [];

        for (const [respName, respData] of Object.entries(currentResponsibilities)) {

            if (respData.responsibles && respData.responsibles.includes(userId)) {

                const otherResponsibles = respData.responsibles.filter(id => id !== userId);

                const category = findCategoryForResp(respName);

                userResponsibilities.push({

                    name: respName,

                    description: respData.description || 'لا يوجد وصف',

                    otherResponsiblesCount: otherResponsibles.length,

                    category: category

                });

            }

        }

        // إنشاء الرد

        if (userResponsibilities.length === 0) {

            const displayName = targetUser.displayName || targetUser.username;

            const noRespEmbed = colorManager.createEmbed()

                .setTitle(`مسؤوليات ${displayName}`)

                .setDescription(userId === message.author.id ?

                    '**ليس لديك أي مسؤوليات معينة حتى الآن.**' :

                    `**${displayName} ليس لديه أي مسؤوليات معينة حتى الآن.**`)

                .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }));

            await message.channel.send({ embeds: [noRespEmbed] });

        } else {

            // فحص إذا كانت جميع المسؤوليات من نفس القسم

            const categories = userResponsibilities.map(r => r.category).filter(c => c !== null);

            const uniqueCategories = [...new Set(categories)];

            const allSameCategory = uniqueCategories.length === 1 && categories.length === userResponsibilities.length;

            let responsibilitiesList;

            let descriptionText = userId === message.author.id ? '** Your Res :**\n\n' : `**Res ${targetUser.displayName || targetUser.username}:**\n\n`;

            // تجميع المسؤوليات حسب القسم
            const groupedResps = {};
            userResponsibilities.forEach(resp => {
                const cat = resp.category || 'No Category';
                if (!groupedResps[cat]) groupedResps[cat] = [];
                groupedResps[cat].push(resp.name);
            });

            const categoriesList = Object.keys(groupedResps);
            
            if (categoriesList.length === 1 && categoriesList[0] !== 'No Category') {
                // جميع المسؤوليات من نفس القسم - عرض مميز
                descriptionText += `<:emoji_4:1428973990315167814>  **Category : ${categoriesList[0]}**\n\n`;
                descriptionText += groupedResps[categoriesList[0]].map((name, index) => 
                    `**${index + 1} :** ${name}`
                ).join('\n');
            } else {
                // تجميع وعرض الأقسام
                let index = 1;
                const formattedGroups = [];
                
                // عرض الأقسام الحقيقية أولاً
                for (const cat of categoriesList) {
                    if (cat === 'No Category') continue;
                    const resps = groupedResps[cat];
                    const respsText = resps.map(name => `**${index++} :** ${name}`).join('\n');
                    formattedGroups.push(`<:emoji_4:1428973990315167814>  **Category : ${cat}**\n${respsText}`

);
                }
                
                // عرض المسؤوليات بدون قسم في النهاية
                if (groupedResps['No Category']) {
                    const respsText = groupedResps['No Category'].map(name => `**${index++}.** ${name}`).join('\n');
                    formattedGroups.push(respsText);
                }
                
                descriptionText += formattedGroups.join('\n\n');
            }

            const displayName = targetUser.displayName || targetUser.username;
            const respEmbed = colorManager.createEmbed()
                .setTitle(`Res : ${displayName}`)
                .setDescription(descriptionText)
                .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
                .addFields([
                    { name: 'All Res', value: `${userResponsibilities.length}`, inline: true },
                    { name: 'Person', value: `<@${userId}>`, inline: true }
                ])
                .setFooter({ text: 'By Ahmed.' })
                .setTimestamp();

            const selectMenu = new StringSelectMenuBuilder()

                .setCustomId('masooliyati_select_desc')

                .setPlaceholder('اختر مسؤولية لعرض شرحها')

                .addOptions(userResponsibilities.map(resp => ({

                    label: resp.name.substring(0, 100),

                    value: resp.name,

                })));

            const row = new ActionRowBuilder().addComponents(selectMenu);

            const sentMessage = await message.channel.send({ embeds: [respEmbed], components: [row] });

            const filter = (interaction) =>
                interaction.customId === 'masooliyati_select_desc' &&
                interaction.user.id === message.author.id;

            const collector = sentMessage.createMessageComponentCollector({ filter, time: 600000 }); // 10 minutes

            collector.on('collect', async (interaction) => {
                const selectedRespName = interaction.values[0];
                const selectedResp = userResponsibilities.find(r => r.name === selectedRespName);

                if (selectedResp) {
                    const desc = selectedResp.description || 'لا يوجد وصف لهذه المسؤولية.';
                    
                    if (desc.length > 2000) {
                        const parts = [];
                        let current = '';
                        for (const line of desc.split('\n')) {
                            if ((current + line + '\n').length > 2000) {
                                parts.push(current);
                                current = '';
                            }
                            current += line + '\n';
                        }
                        if (current.trim()) parts.push(current);

                        for (let i = 0; i < parts.length; i++) {
                            const content = i === 0 ? `**شرح مسؤولية "${selectedRespName}" :**\n${parts[i]}` : parts[i];
                            if (i === 0) {
                                await interaction.reply({ content, ephemeral: true });
                            } else {
                                await interaction.followUp({ content, ephemeral: true });
                            }
                        }
                    } else {
                        await interaction.reply({
                            content: `**شرح مسؤولية "${selectedRespName}" :**\n${desc}`,
                            ephemeral: true
                        });
                    }
                }
            });

            collector.on('end', () => {
                collector.removeAllListeners();
                const disabledRow = new ActionRowBuilder().addComponents(
                    StringSelectMenuBuilder.from(selectMenu).setDisabled(true)
                );
                sentMessage.edit({ components: [disabledRow] }).catch(() => {});
            });

        }

    }

};