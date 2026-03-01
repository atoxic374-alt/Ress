const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { logEvent } = require('../utils/logs_system.js');
const fs = require('fs');
const path = require('path');

const name = 'owners';

// مسار ملف إعدادات البوت
const botConfigPath = path.join(__dirname, '..', 'data', 'botConfig.json');

// دالة لقراءة إعدادات البوت
function loadBotConfig() {
    try {
        if (fs.existsSync(botConfigPath)) {
            const data = fs.readFileSync(botConfigPath, 'utf8');
            return JSON.parse(data);
        }
        return {
            owners: [],
            prefix: null,
            settings: {},
            activeTasks: {}
        };
    } catch (error) {
        console.error('خطأ في قراءة botConfig:', error);
        return {
            owners: [],
            prefix: null,
            settings: {},
            activeTasks: {}
        };
    }
}

// دالة لحفظ إعدادات البوت
function saveBotConfig(config) {
    try {
        fs.writeFileSync(botConfigPath, JSON.stringify(config, null, 2));
        return true;
    } catch (error) {
        console.error('خطأ في حفظ botConfig:', error);
        return false;
    }
}

// Helper function to check if a user is blocked
function isUserBlocked(userId) {
    // This is a placeholder. In a real scenario, you would load blocked users from a file or database.
    // For now, we'll assume no users are blocked.
    // Example: return blockedUserIds.includes(userId);
    return false;
}

async function execute(message, args, { client, scheduleSave, BOT_OWNERS }) {
    // فحص البلوك أولاً
    if (isUserBlocked(message.author.id)) {
        const blockedEmbed = colorManager.createEmbed()
            .setDescription('**🚫 أنت محظور من استخدام أوامر البوت**\n**للاستفسار، تواصل مع إدارة السيرفر**')
            .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

        await message.channel.send({ embeds: [blockedEmbed] });
        return;
    }

    // إعادة تحميل المالكين من الملف للتأكد من أحدث البيانات
    if (global.reloadBotOwners) {
        global.reloadBotOwners();
    }

    // معالجات قوية للسيرفرات الكبيرة
    const MAX_CONCURRENT_OPERATIONS = 10;
    const activeOperations = new Set();
    const rateLimitMap = new Map();

    // Only current bot owners can manage other owners
    if (!BOT_OWNERS.includes(message.author.id)) {
        console.log(`❌ المستخدم ${message.author.id} ليس مالك. المالكين الحاليين:`, BOT_OWNERS);
        await message.react('❌');
        return;
    }

    const botAvatarURL = client.user.displayAvatarURL({ dynamic: true });
    const embedColor = colorManager.getColor(botAvatarURL);

    // Create main menu embed
    const embed = new EmbedBuilder()
        .setTitle('Owners sys')
        .setDescription(`**The owners :**\n${BOT_OWNERS.length > 0 ? BOT_OWNERS.map((o, i) => `${i + 1}. <@${o}>`).join('\n') : 'No owners'}`)
        .setColor(embedColor)
        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390916564582400/318aaf0d30ab2b543f644fd161a185d9-removebg-preview.png?ex=688d1fec&is=688bce6c&hm=aec603b47db79f12933573867075bfcdc1bbd8d40471cc2ded2bade36ef3a372&')
        .setFooter({ text: 'Choose' });

    // Create buttons
    const addButton = new ButtonBuilder()
        .setCustomId('owners_add')
        .setLabel('Add owner')
        .setStyle(ButtonStyle.Success)
        .setEmoji('<:emoji_87:1442988617294413864>');

    const removeButton = new ButtonBuilder()
        .setCustomId('owners_remove')
        .setLabel('Delete owner')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('<:emoji_88:1442988669836202086>');

    const listButton = new ButtonBuilder()
        .setCustomId('owners_list')
        .setLabel('list')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('<:emoji_88:1442988704481280123>');

    const row = new ActionRowBuilder().addComponents(addButton, removeButton, listButton);

    const sentMessage = await message.channel.send({ embeds: [embed], components: [row] });

    // Create collector for buttons
    const filter = i => i.user.id === message.author.id && i.message.id === sentMessage.id;
    const collector = message.channel.createMessageComponentCollector({ filter, time: 300000 });

    collector.on('collect', async interaction => {
        // معالجات قوية للتفاعلات
        const operationId = `owners_${interaction.user.id}_${Date.now()}`;

        try {
            // التحقق من صلاحية التفاعل
            if (!interaction || !interaction.isRepliable()) {
                console.log('تفاعل غير صالح في owners');
                return;
            }

            // منع التفاعلات المتكررة
            if (interaction.replied || interaction.deferred) {
                console.log('تم تجاهل تفاعل متكرر في owners');
                return;
            }

            // فحص عمر التفاعل
            const now = Date.now();
            const interactionAge = now - interaction.createdTimestamp;

            if (interactionAge > 14 * 60 * 1000) {
                console.log('تم تجاهل تفاعل منتهي الصلاحية في owners');
                return;
            }

            if (interaction.customId === 'owners_add') {
                const addEmbed = new EmbedBuilder()
                    .setDescription('**يرجى ارسال المنشن او الايدي**')
                    .setColor(embedColor)
                    .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400645490118234132/download__8_-removebg-preview.png?ex=688d6443&is=688c12c3&hm=217945651e6a5f649ede7719b4572da60d009a8aa461a507b72e2f82ea59a4cd&');

                await interaction.reply({ embeds: [addEmbed], ephemeral: true });

                // Create message collector
                const messageFilter = m => m.author.id === interaction.user.id;
                const messageCollector = interaction.channel.createMessageCollector({ 
                    filter: messageFilter, 
                    time: 60000, 
                    max: 1 
                });

                messageCollector.on('collect', async (msg) => {
                    try {
                        await msg.delete().catch(() => {});

                        let userId = null;
                        if (msg.mentions.users.size > 0) {
                            userId = msg.mentions.users.first().id;
                        } else {
                            userId = msg.content.trim().replace(/[<@!>]/g, '');
                        }

                        if (!userId || !/^\d+$/.test(userId)) {
                            const errorEmbed = new EmbedBuilder()
                                .setDescription('**اي دي او منشن غلط**')
                                .setColor(embedColor)
                                .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390144795738175/download__2_-removebg-preview.png?ex=688d1f34&is=688bcdb4&hm=40da8d91a92062c95eb9d48f307697ec0010860aca64dd3f8c3c045f3c2aa13a&');

                            return interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
                        }

                        if (BOT_OWNERS.includes(userId)) {
                            const alreadyEmbed = new EmbedBuilder()
                                .setDescription('**ذا اونر اصلا**')
                                .setColor(embedColor)
                                .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390888416608286/download__3_-removebg-preview.png?ex=688d1fe5&is=688bce65&hm=55055a587668561ce27baf0665663f801e14662d4bf849351564a563b1e53b41&');

                            return interaction.followUp({ embeds: [alreadyEmbed], ephemeral: true });
                        }

                        try {
                            const user = await client.users.fetch(userId);
                            // إضافة المالك للمصفوفة المحلية
                            BOT_OWNERS.push(userId);

                            // تحديث ملف botConfig.json أولاً
                            let botConfig = loadBotConfig();
                            botConfig.owners = [...BOT_OWNERS]; // نسخ المصفوفة
                            const saveSuccess = saveBotConfig(botConfig);

                            if (saveSuccess) {
                                // تحديث المتغير العالمي فقط بعد نجاح الحفظ
                                if (global.updateBotOwners) {
                                    global.updateBotOwners([...BOT_OWNERS]);
                                }
                                
                                // تحديث القائمة العالمية فوراً لضمان مزامنة الأوامر
                                global.BOT_OWNERS = [...BOT_OWNERS];

                                // تحديث متغير البيئة
                                process.env.BOT_OWNERS = BOT_OWNERS.join(',');

                                console.log(`✅ تمت إضافة المالك ${userId} بنجاح. المالكين الحاليين:`, BOT_OWNERS);
                            } else {
                                // إذا فشل الحفظ، إزالة المالك من المصفوفة المحلية
                                BOT_OWNERS.pop();
                                throw new Error('فشل في حفظ ملف الإعدادات');
                            }

                            scheduleSave();

                            // Log the event
                            logEvent(client, message.guild, {
                                type: 'ADMIN_ACTIONS',
                                title: 'Bot Owner Added',
                                description: `A new bot owner has been added`,
                                user: message.author,
                                fields: [
                                    { name: 'Added Owner', value: `<@${userId}> (${user.username})`, inline: true }
                                ]
                            });

                            const successEmbed = new EmbedBuilder()
                                .setDescription(`**✅ Complete add ${user.username}**`)
                                .setColor(embedColor)
                                .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400645490118234132/download__8_-removebg-preview.png?ex=688d6443&is=688c12c3&hm=217945651e6a5f649ede7719b4572da60d009a8aa461a507b72e2f82ea59a4cd&');

                            await interaction.followUp({ embeds: [successEmbed], ephemeral: true });

                            // Update main menu
                            const newEmbed = new EmbedBuilder()
                                .setTitle('owners sys')
                                .setDescription(`** owners :**\n${BOT_OWNERS.length > 0 ? BOT_OWNERS.map((o, i) => `${i + 1}. <@${o}>`).join('\n') : 'No owners'}`)
                                .setColor(embedColor)
                                .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390916564582400/318aaf0d30ab2b543f644fd161a185d9-removebg-preview.png?ex=688d1fec&is=688bce6c&hm=aec603b47db79f12933573867075bfcdc1bbd8d40471cc2ded2bade36ef3a372&')
                                .setFooter({ text: 'Choose' });

                            await sentMessage.edit({ embeds: [newEmbed], components: [row] });

                        } catch (error) {
                            const notFoundEmbed = new EmbedBuilder()
                                .setDescription('**لم يتم العثور على هذا الشخص!**')
                                .setColor(embedColor)
                                .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390888416608286/download__3_-removebg-preview.png?ex=688d1fe5&is=688bce65&hm=55055a587668561ce27baf0665663f801e14662d4bf849351564a563b1e53b41&');

                            await interaction.followUp({ embeds: [notFoundEmbed], ephemeral: true });
                        }
                    } catch (error) {
                        console.error('Error processing owner addition:', error);
                        await interaction.followUp({ content: '**حدث خطأ أثناء إضافة الاونر.**', ephemeral: true });
                    }
                });

                messageCollector.on('end', (collected) => {
                    if (collected.size === 0) {
                        interaction.followUp({ content: '**انتهت مهلة الانتظار.**', ephemeral: true }).catch(() => {});
                    }
                });

            } else if (interaction.customId === 'owners_remove') {
                if (BOT_OWNERS.length <= 1) {
                    const errorEmbed = new EmbedBuilder()
                        .setDescription('**لازم واحد عالاقل اونر**')
                        .setColor(embedColor)
                        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390888416608286/download__3_-removebg-preview.png?ex=688d1fe5&is=688bce65&hm=55055a587668561ce27baf0665663f801e14662d4bf849351564a563b1e53b41&');

                    return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
                }

                let ownersList = '**اختر رقم المالك الذي تريد حذفه:**\n\n';
                for (let i = 0; i < BOT_OWNERS.length; i++) {
                    try {
                        const user = await client.users.fetch(BOT_OWNERS[i]);
                        ownersList += `${i + 1}. ${user.username} (<@${BOT_OWNERS[i]}>)\n`;
                    } catch (error) {
                        ownersList += `${i + 1}. مستخدم غير موجود (${BOT_OWNERS[i]})\n`;
                    }
                }
                ownersList += '\n**send number :**';

                const removeEmbed = new EmbedBuilder()
                    .setDescription(ownersList)
                    .setColor(embedColor)
                    .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400661744682139690/download__1_-removebg-preview.png?ex=688d7366&is=688c21e6&hm=5635fe92ec3d4896d9ca065b9bb8ee11a5923b9e5d75fe94b753046e7e8b24eb&');

                await interaction.reply({ embeds: [removeEmbed], ephemeral: true });

                // Create message collector for numbers
                const messageFilter = m => m.author.id === interaction.user.id;
                const messageCollector = interaction.channel.createMessageCollector({ 
                    filter: messageFilter, 
                    time: 60000, 
                    max: 1 
                });

                messageCollector.on('collect', async (msg) => {
                    try {
                        await msg.delete().catch(() => {});

                        const num = parseInt(msg.content.trim());
                        if (isNaN(num) || num < 1 || num > BOT_OWNERS.length) {
                            const errorEmbed = new EmbedBuilder()
                                .setDescription('**رقم غير صحيح !**')
                                .setColor(embedColor)
                                .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390888416608286/download__3_-removebg-preview.png?ex=688d1fe5&is=688bce65&hm=55055a587668561ce27baf0665663f801e14662d4bf849351564a563b1e53b41&');

                            return interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
                        }

                        const removedOwnerId = BOT_OWNERS[num - 1];

                        // Prevent removing self if it's the last owner
                        if (removedOwnerId === message.author.id && BOT_OWNERS.length === 1) {
                            const errorEmbed = new EmbedBuilder()
                                .setDescription('**لا يمكنك ازاله اخر اونر**')
                                .setColor(embedColor)
                                .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390888416608286/download__3_-removebg-preview.png?ex=688d1fe5&is=688bce65&hm=55055a587668561ce27baf0665663f801e14662d4bf849351564a563b1e53b41&');

                            return interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
                        }

                        try {
                            const removedUser = await client.users.fetch(removedOwnerId);
                            // حفظ المعرف المحذوف للتراجع في حالة الفشل
                            const removedId = BOT_OWNERS[num - 1];
                            
                            // حذف المالك من المصفوفة المحلية
                            BOT_OWNERS.splice(num - 1, 1);

                            // تحديث ملف botConfig.json أولاً
                            let botConfig = loadBotConfig();
                            botConfig.owners = [...BOT_OWNERS]; // نسخ المصفوفة
                            const saveSuccess = saveBotConfig(botConfig);

                            if (saveSuccess) {
                                // تحديث المتغير العالمي فقط بعد نجاح الحفظ
                                if (global.updateBotOwners) {
                                    global.updateBotOwners([...BOT_OWNERS]);
                                }
                                
                                // تحديث القائمة العالمية فوراً لضمان مزامنة الأوامر
                                global.BOT_OWNERS = [...BOT_OWNERS];

                                // تحديث متغير البيئة
                                process.env.BOT_OWNERS = BOT_OWNERS.join(',');

                                console.log(`✅ تم حذف المالك ${removedId} بنجاح. المالكين الحاليين:`, BOT_OWNERS);
                            } else {
                                // إذا فشل الحفظ، إعادة المالك للمصفوفة المحلية
                                BOT_OWNERS.splice(num - 1, 0, removedId);
                                throw new Error('فشل في حفظ ملف الإعدادات');
                            }

                            scheduleSave();

                            // Log the event
                            logEvent(client, message.guild, {
                                type: 'ADMIN_ACTIONS',
                                title: 'Bot Owner Removed',
                                description: `A bot owner has been removed`,
                                user: message.author,
                                fields: [
                                    { name: 'Removed Owner', value: `<@${removedOwnerId}> (${removedUser.username})`, inline: true }
                                ]
                            });

                            const successEmbed = new EmbedBuilder()
                                .setDescription(`**✅ Completely delete ${removedUser.username}!**`)
                                .setColor(embedColor)
                                .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400645486272057364/download__7_-removebg-preview.png?ex=688d6442&is=688c12c2&hm=2375cd57724a3ffe3b0073bef7fa7d1aa08f3b79200e33f346cdce03cfd27e9a&');

                            await interaction.followUp({ embeds: [successEmbed], ephemeral: true });

                        } catch (error) {
                            // حذف حتى لو لم يتم العثور على المستخدم
                            const removedId = BOT_OWNERS[num - 1];
                            BOT_OWNERS.splice(num - 1, 1);

                            // تحديث ملف botConfig.json أولاً
                            let botConfig = loadBotConfig();
                            botConfig.owners = [...BOT_OWNERS]; // نسخ المصفوفة
                            const saveSuccess = saveBotConfig(botConfig);

                            if (saveSuccess) {
                                // تحديث المتغير العالمي فقط بعد نجاح الحفظ
                                if (global.updateBotOwners) {
                                    global.updateBotOwners([...BOT_OWNERS]);
                                }
                                
                                // تحديث القائمة العالمية فوراً لضمان مزامنة الأوامر
                                global.BOT_OWNERS = [...BOT_OWNERS];

                                // تحديث متغير البيئة
                                process.env.BOT_OWNERS = BOT_OWNERS.join(',');

                                console.log(`✅ تم حذف المالك ${removedId} (مستخدم غير موجود). المالكين الحاليين:`, BOT_OWNERS);
                            } else {
                                // إذا فشل الحفظ، إعادة المالك للمصفوفة المحلية
                                BOT_OWNERS.splice(num - 1, 0, removedId);
                                throw new Error('فشل في حفظ ملف الإعدادات');
                            }

                            scheduleSave();

                            const successEmbed = new EmbedBuilder()
                                .setDescription('**Complete delete**')
                                .setColor(embedColor)
                                .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400645490118234132/download__8_-removebg-preview.png?ex=688d6443&is=688c12c3&hm=217945651e6a5f649ede7719b4572da60d009a8aa461a507b72e2f82ea59a4cd&');

                            await interaction.followUp({ embeds: [successEmbed], ephemeral: true });
                        }

                        // Update main menu
                        const newEmbed = new EmbedBuilder()
                            .setTitle('Owners sys')
                            .setDescription(`**Owners :**\n${BOT_OWNERS.length > 0 ? BOT_OWNERS.map((o, i) => `${i + 1}. <@${o}>`).join('\n') : 'no owners'}`)
                            .setColor(embedColor)
                            .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390916564582400/318aaf0d30ab2b543f644fd161a185d9-removebg-preview.png?ex=688d1fec&is=688bce6c&hm=aec603b47db79f12933573867075bfcdc1bbd8d40471cc2ded2bade36ef3a372&')
                            .setFooter({ text: 'Choose' });

                        await sentMessage.edit({ embeds: [newEmbed], components: [row] });
                    } catch (error) {
                        console.error('Error processing owner removal:', error);
                        await interaction.followUp({ content: '**حدث خطأ أثناء معالجة المالكين.**', ephemeral: true });
                    }
                });

                messageCollector.on('end', (collected) => {
                    if (collected.size === 0) {
                        interaction.followUp({ content: '**انتهت مهلة الانتظار.**', ephemeral: true }).catch(() => {});
                    }
                });

            } else if (interaction.customId === 'owners_list') {
                if (BOT_OWNERS.length === 0) {
                    const noOwnersEmbed = new EmbedBuilder()
                        .setDescription('**no owners yet**')
                        .setColor(embedColor)
                        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390144795738175/download__2_-removebg-preview.png?ex=688d1f34&is=688bcdb4&hm=40da8d91a92062c95eb9d48f307697ec0010860aca64dd3f8c3c045f3c2aa13a&');

                    return interaction.reply({ embeds: [noOwnersEmbed], ephemeral: true });
                }

                let ownersList = '**list :**\n\n';
                for (let i = 0; i < BOT_OWNERS.length; i++) {
                    const ownerId = BOT_OWNERS[i];
                    try {
                        const user = await client.users.fetch(ownerId);
                        ownersList += `${i + 1}. **${user.username}** - <@${ownerId}>\n`;
                    } catch (error) {
                        ownersList += `${i + 1}. **مستخدم غير موجود** - ${ownerId}\n`;
                    }
                }

                const listEmbed = new EmbedBuilder()
                    .setTitle('**Owners List**')
                    .setDescription(ownersList)
                    .setColor(embedColor)
                    .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400661717582745640/images__3_-removebg-preview.png?ex=688d7360&is=688c21e0&hm=c1e7b01d1b7a5420184eb4049f72e6f92ee05dbb70cd68f06ecbc0592dacb446&')
                    .setTimestamp()
                    .setFooter({ text: `All owners: ${BOT_OWNERS.length}` });

                await interaction.reply({ embeds: [listEmbed], ephemeral: true });
            }

        } catch (error) {
            console.error('Error in owners collector:', error);
            try {
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({ content: '**حدث خطأ أثناء معالجة الطلب.**', ephemeral: true });
                } else {
                    await interaction.reply({ content: '**حدث خطأ أثناء معالجة الطلب.**', ephemeral: true });
                }
            } catch (replyError) {
                console.error('Failed to send error reply:', replyError);
            }
        }
    });

    collector.on('end', () => {
        const disabledRow = new ActionRowBuilder().addComponents(
            addButton.setDisabled(true),
            removeButton.setDisabled(true),
            listButton.setDisabled(true)
        );
        sentMessage.edit({ components: [disabledRow] }).catch(console.error);
    });
}

module.exports = { name, execute };