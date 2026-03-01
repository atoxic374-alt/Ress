const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ActivityType } = require('discord.js');
const colorManager = require('../utils/colorManager');
const { logEvent } = require('../utils/logs_system');
const { isUserBlocked } = require('./block.js');
const fs = require('fs');
const path = require('path');

const name = 'vip';

const botStatusPath = path.join(__dirname, '..', 'data', 'botStatus.json');

function loadBotStatus() {
    try {
        if (fs.existsSync(botStatusPath)) {
            const data = fs.readFileSync(botStatusPath, 'utf8');
            return JSON.parse(data);
        }
        return {
            status: 'online',
            activityText: null,
            activityType: null,
            streamUrl: null
        };
    } catch (error) {
        console.error('خطأ في تحميل حالة البوت:', error);
        return {
            status: 'online',
            activityText: null,
            activityType: null,
            streamUrl: null
        };
    }
}

function saveBotStatus(statusData) {
    try {
        fs.writeFileSync(botStatusPath, JSON.stringify(statusData, null, 2), 'utf8');
        console.log('✅ تم حفظ حالة البوت بنجاح');
        return true;
    } catch (error) {
        console.error('خطأ في حفظ حالة البوت:', error);
        return false;
    }
}

async function execute(message, args, { responsibilities, BOT_OWNERS, client, saveData }) {
    // فحص البلوك أولاً
    if (isUserBlocked(message.author.id)) {
        const blockedEmbed = colorManager.createEmbed()
            .setDescription('**🚫 أنت محظور من استخدام أوامر البوت**\n**للاستفسار، تواصل مع إدارة السيرفر**')
            .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

        await message.channel.send({ embeds: [blockedEmbed] });
        return;
    }

    if (!BOT_OWNERS.includes(message.author.id) && message.guild.ownerId !== message.author.id) {
        await message.react('❌');
        return;
    }

    const guild = message.guild;
    const owners = BOT_OWNERS.length;

    // قراءة البرفكس الحالي من ملف التكوين
    const botConfigFile = path.join(__dirname, '..', 'data', 'botConfig.json');
    let currentPrefix = null;
    let currentActivityText = null;

    if (fs.existsSync(botConfigFile)) {
        try {
            const botConfig = JSON.parse(fs.readFileSync(botConfigFile, 'utf8'));
            currentPrefix = botConfig.prefix || null;
        } catch (error) {
            console.error('خطأ في قراءة البرفكس:', error);
            currentPrefix = null;
        }
    }

    const responsibilityCount = Object.keys(responsibilities).length;
    let totalResponsibles = 0;

    for (const resp in responsibilities) {
        if (responsibilities[resp].responsibles) {
            totalResponsibles += responsibilities[resp].responsibles.length;
        }
    }

    const embed = colorManager.createEmbed()
        .setTitle('Bot config')
        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400722238927536208/images__11_-removebg-preview.png?ex=688dabbd&is=688c5a3d&hm=d3d2f91cf09599fa234e240d7b838e689663b2c0353c3791bdb181c3bffaeff4&')
        .addFields([
            { name: '**Owners : **', value: `**__${owners}__**`, inline: true },
            { name: '**Prefix :**', value: `**${currentPrefix === '' ? 'بدون بريفكس' : currentPrefix}**`, inline: true },
            { name: '**Res count :**', value: `**${responsibilityCount}**`, inline: true },
            { name: '**Resb count **', value: `__**${totalResponsibles}**__`, inline: true }
        ])
        .setTimestamp();

    const buttons = [
        new ButtonBuilder()
            .setCustomId('vip_change_name')
            .setLabel('Name')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('vip_change_avatar')
            .setLabel('Avatar')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('vip_change_banner')
            .setLabel('Banner')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('vip_bot_status')
            .setLabel('Status')
            .setStyle(ButtonStyle.Secondary)
    ];

    const row1 = new ActionRowBuilder().addComponents(buttons.slice(0, 4));
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('vip_change_prefix')
            .setLabel('Change Prefix')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('vip_restart_bot')
            .setLabel('Restart')
            .setStyle(ButtonStyle.Danger)
    );

    const sentMessage = await message.channel.send({
        embeds: [embed],
        components: [row1, row2]
    });

    const filter = i => i.user.id === message.author.id;
    const collector = message.channel.createMessageComponentCollector({ filter, time: 300000 });

    collector.on('collect', async interaction => {
        try {
            if (interaction.customId === 'vip_change_name') {
                const modal = new ModalBuilder()
                    .setCustomId('change_name_modal')
                    .setTitle('Set bot namee');

                const nameInput = new TextInputBuilder()
                    .setCustomId('bot_name')
                    .setLabel('New name')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(32)
                    .setPlaceholder('أدخل الاسم الجديد...');

                const actionRow = new ActionRowBuilder().addComponents(nameInput);
                modal.addComponents(actionRow);

                await interaction.showModal(modal);

            } else if (interaction.customId === 'vip_change_avatar') {
                const embed = colorManager.createEmbed()
                    .setDescription('**ارسل الافتار **')
                    .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400660696072589312/images__8_-removebg-preview.png?ex=688d726c&is=688c20ec&hm=3b2bebab178bae617041b9c2d4959a25e1013421f63ed17fa99b27d1a0113508&');

                await interaction.reply({
                    embeds: [embed],
                    ephemeral: true
                });

                const filter = m => m.author.id === interaction.user.id;
                const collector = interaction.channel.createMessageCollector({ filter, time: 60000, max: 1 });

                collector.on('collect', async (msg) => {
                    try {
                        let avatarUrl = null;

                        // Check if message has attachment
                        if (msg.attachments.size > 0) {
                            const attachment = msg.attachments.first();
                            if (attachment.contentType && attachment.contentType.startsWith('image/')) {
                                avatarUrl = attachment.url;
                            }
                        } else if (msg.content.trim()) {
                            const url = msg.content.trim();
                            if (url.startsWith('http://') || url.startsWith('https://')) {
                                avatarUrl = url;
                            }
                        }

                        if (!avatarUrl) {
                            const errorEmbed = colorManager.createEmbed()
                                .setDescription('**يرجى إرسال رابط صورة صالح أو إرفاق صورة !**')
                                .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390888416608286/download__3_-removebg-preview.png?ex=688d1fe5&is=688bce65&hm=55055a587668561ce27baf0665663f801e14662d4bf849351564a563b1e53b41&');

                            return interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
                        }

                        try {
                            await client.user.setAvatar(avatarUrl);

                            await msg.delete().catch(() => { });

                            // تحديث ألوان الـ embeds تلقائياً
                            setTimeout(async () => {
                                await colorManager.forceUpdateColor();
                            }, 2000); // انتظار ثانيتين للتأكد من تحديث الأفتار

                            logEvent(client, message.guild, {
                                type: 'ADMIN_ACTIONS',
                                title: 'Bot Avatar Changed',
                                description: 'The bot avatar has been updated',
                                user: message.author,
                                fields: [
                                    { name: 'New Avatar URL', value: avatarUrl, inline: false }
                                ]
                            });

                            const successEmbed = colorManager.createEmbed()
                                .setDescription('**Comblete change ✅️**')
                                .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400645490118234132/download__8_-removebg-preview.png?ex=688d6443&is=688c12c3&hm=217945651e6a5f649ede7719b4572da60d009a8aa461a507b72e2f82ea59a4cd&');

                            await interaction.followUp({ embeds: [successEmbed], ephemeral: true });

                        } catch (error) {
                            console.error('Error changing bot avatar:', error);
                            await msg.delete().catch(() => { });
                            const errorEmbed = colorManager.createEmbed()
                                .setDescription('**❌ حدث خطأ أثناء تغيير الأفتار ! تأكد من صحة الرابط.**')
                                .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390888416608286/download__3_-removebg-preview.png?ex=688d1fe5&is=688bce65&hm=55055a587668561ce27baf0665663f801e14662d4bf849351564a563b1e53b41&');

                            await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
                        }
                    } catch (error) {
                        console.error('Error processing avatar change:', error);
                    }
                });

                collector.on('end', (collected) => {
                    if (collected.size === 0) {
                        interaction.followUp({ content: '**انتهت مهلة الانتظار.**', ephemeral: true }).catch(() => { });
                    }
                });

            } else if (interaction.customId === 'vip_change_banner') {
                const embed = colorManager.createEmbed()
                    .setDescription('**ارسل البنر**')
                    .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400660696072589312/images__8_-removebg-preview.png?ex=688d726c&is=688c20ec&hm=3b2bebab178bae617041b9c2d4959a25e1013421f63ed17fa99b27d1a0113508&');

                await interaction.reply({
                    embeds: [embed],
                    ephemeral: true
                });

                const filter = m => m.author.id === interaction.user.id;
                const collector = interaction.channel.createMessageCollector({ filter, time: 60000, max: 1 });

                collector.on('collect', async (msg) => {
                    try {
                        let bannerUrl = null;

                        if (msg.attachments.size > 0) {
                            const attachment = msg.attachments.first();
                            if (attachment.contentType && attachment.contentType.startsWith('image/')) {
                                bannerUrl = attachment.url;
                            }
                        } else if (msg.content.trim()) {
                            const url = msg.content.trim();
                            if (url.startsWith('http://') || url.startsWith('https://')) {
                                bannerUrl = url;
                            }
                        }

                        if (!bannerUrl) {
                            const errorEmbed = colorManager.createEmbed()
                                .setDescription('**يرجى إرسال رابط صورة صالح أو إرفاق صورة !**')
                                .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390888416608286/download__3_-removebg-preview.png?ex=688d1fe5&is=688bce65&hm=55055a587668561ce27baf0665663f801e14662d4bf849351564a563b1e53b41&');

                            return interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
                        }

                        try {
                            await client.user.setBanner(bannerUrl);

                            await msg.delete().catch(() => { });

                            logEvent(client, message.guild, {
                                type: 'ADMIN_ACTIONS',
                                title: 'Bot Banner Changed',
                                description: 'The bot banner has been updated',
                                user: message.author,
                                fields: [
                                    { name: 'New Banner URL', value: bannerUrl, inline: false }
                                ]
                            });

                            const successEmbed = colorManager.createEmbed()
                                .setDescription('**✅ Complete change**')
                                .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400645490118234132/download__8_-removebg-preview.png?ex=688d6443&is=688c12c3&hm=217945651e6a5f649ede7719b4572da60d009a8aa461a507b72e2f82ea59a4cd&');

                            await interaction.followUp({ embeds: [successEmbed], ephemeral: true });

                        } catch (error) {
                            console.error('Error changing bot banner:', error);
                            await msg.delete().catch(() => { });
                            const errorEmbed = colorManager.createEmbed()
                                .setDescription('**❌ حدث خطأ أثناء تغيير البنر ! تأكد من صحة الرابط.**')
                                .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390888416608286/download__3_-removebg-preview.png?ex=688d1fe5&is=688bce65&hm=55055a587668561ce27baf0665663f801e14662d4bf849351564a563b1e53b41&');

                            await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
                        }
                    } catch (error) {
                        console.error('Error processing banner change:', error);
                    }
                });

                collector.on('end', (collected) => {
                    if (collected.size === 0) {
                        interaction.followUp({ content: '**انتهت مهلة الانتظار.**', ephemeral: true }).catch(() => { });
                    }
                });

            } else if (interaction.customId === 'vip_bot_status') {
                const statusEmbed = colorManager.createEmbed()
                    .setTitle('Bot Status Settings')
                    .setDescription('**اختر نوع الحالة أولاً:**')
                    .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400660696072589312/images__8_-removebg-preview.png?ex=688d726c&is=688c20ec&hm=3b2bebab178bae617041b9c2d4959a25e1013421f63ed17fa99b27d1a0113508&');

                const statusSelect = new StringSelectMenuBuilder()
                    .setCustomId('vip_status_select')
                    .setPlaceholder('اختر نوع الحالة')
                    .addOptions([
                        {
                            label: 'Playing',
                            description: 'يلعب',
                            value: 'playing'
                        },
                        {
                            label: 'Watching',
                            description: 'يشاهد',
                            value: 'watching'
                        },
                        {
                            label: 'Listening',
                            description: 'يستمع',
                            value: 'listening'
                        },
                        {
                            label: 'Streaming',
                            description: 'يبث مباشر',
                            value: 'streaming'
                        },
                        {
                            label: 'Competing',
                            description: 'يتنافس',
                            value: 'competing'
                        }
                    ]);

                const statusRow = new ActionRowBuilder().addComponents(statusSelect);

                await interaction.reply({
                    embeds: [statusEmbed],
                    components: [statusRow],
                    ephemeral: true
                });

            } else if (interaction.customId === 'vip_change_prefix') {
                const modal = new ModalBuilder()
                    .setCustomId('change_prefix_modal')
                    .setTitle('Change Prefix');

                const prefixInput = new TextInputBuilder()
                    .setCustomId('bot_prefix')
                    .setLabel(' New prefxix (اتركه فارغ لإزالة البرفكس)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setMaxLength(5)
                    .setValue(currentPrefix || '')
                    .setPlaceholder('مثال: ! أو # أو اتركه فارغ');

                const actionRow = new ActionRowBuilder().addComponents(prefixInput);
                modal.addComponents(actionRow);

                await interaction.showModal(modal);

            } else if (interaction.customId === 'vip_restart_bot') {
                // تأكيد إعادة التشغيل
                const confirmEmbed = colorManager.createEmbed()
                    .setTitle('Make sure ')
                    .setDescription('**هل أنت متأكد من إعادة تشغيل البوت.**')
                    .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400660696072589312/images__8_-removebg-preview.png?ex=688d726c&is=688c20ec&hm=3b2bebab178bae617041b9c2d4959a25e1013421f63ed17fa99b27d1a0113508&');

                const confirmButton = new ButtonBuilder()
                    .setCustomId('confirm_restart_bot')
                    .setLabel('✅ Y')
                    .setStyle(ButtonStyle.Danger);

                const cancelButton = new ButtonBuilder()
                    .setCustomId('cancel_restart_bot')
                    .setLabel('❌ C')
                    .setStyle(ButtonStyle.Secondary);

                const confirmRow = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

                await interaction.reply({
                    embeds: [confirmEmbed],
                    components: [confirmRow],
                    ephemeral: true
                });

                // معالج أزرار التأكيد
                const confirmFilter = i => i.user.id === interaction.user.id &&
                    (i.customId === 'confirm_restart_bot' || i.customId === 'cancel_restart_bot');

                const confirmCollector = interaction.channel.createMessageComponentCollector({
                    filter: confirmFilter,
                    time: 30000
                });

                confirmCollector.on('collect', async confirmInteraction => {
                    try {
                        if (confirmInteraction.customId === 'confirm_restart_bot') {
                            const restartEmbed = colorManager.createEmbed()
                                .setDescription('** جاري إعادة تشغيل البوت**')
                                .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400667127089856522/1224078115479883816.png?ex=688d786a&is=688c26ea&hm=690357effa104ec0a7e2f728ed55058d79d7a50475dcf981a7e0e6ded68d2c97&');

                            await confirmInteraction.update({
                                embeds: [restartEmbed],
                                components: []
                            });

                            // حفظ البيانات قبل إعادة التشغيل
                            if (global.saveData) {
                                global.saveData();
                            }

                            // تسجيل الحدث
                            logEvent(client, message.guild, {
                                type: 'BOT_SETTINGS',
                                title: 'Bot Restart Requested',
                                description: 'Bot restart has been requested by owner',
                                user: message.author,
                                fields: [
                                    { name: 'Requested By', value: `<@${message.author.id}>`, inline: true }
                                ]
                            });

                            // إعادة تشغيل البوت بعد 3 ثوانٍ
                            setTimeout(async () => {
                                console.log('🔄 إعادة تشغيل البوت...');
                                try {
                                    // تسجيل الخروج من Discord
                                    await client.destroy();
                                    console.log('✅ تم قطع الاتصال مع Discord');

                                    // إعادة تسجيل الدخول
                                    await client.login(process.env.DISCORD_TOKEN);
                                    console.log('✅ تم إعادة الاتصال مع Discord بنجاح');
                                } catch (error) {
                                    console.error('❌ فشل في إعادة تشغيل البوت:', error);
                                    // في حالة الفشل، إعادة تشغيل العملية
                                    process.exit(0);
                                }
                            }, 3000);

                        } else if (confirmInteraction.customId === 'cancel_restart_bot') {
                            const cancelEmbed = colorManager.createEmbed()
                                .setDescription('**❌ تم إلغاء إعادة التشغيل**')
                                .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390888416608286/download__3_-removebg-preview.png?ex=688d1fe5&is=688bce65&hm=55055a587668561ce27baf0665663f801e14662d4bf849351564a563b1e53b41&');

                            await confirmInteraction.update({
                                embeds: [cancelEmbed],
                                components: []
                            });
                        }
                    } catch (error) {
                        console.error('خطأ في معالجة تأكيد إعادة التشغيل:', error);
                    }
                });

                confirmCollector.on('end', (collected, reason) => {
                    // فقط إظهار انتهاء المهلة إذا لم يتم الضغط على أي زر
                    if (collected.size === 0 && reason === 'time') {
                        const timeoutEmbed = colorManager.createEmbed()
                            .setDescription('**⏰ انتهت مهلة التأكيد**')
                            .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390888416608286/download__3_-removebg-preview.png?ex=688d1fe5&is=688bce65&hm=55055a587668561ce27baf0665663f801e14662d4bf849351564a563b1e53b41&');

                        interaction.editReply({
                            embeds: [timeoutEmbed],
                            components: []
                        }).catch(() => { });
                    }
                });
            }

        } catch (error) {
            console.error('Error in VIP collector:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '**حدث خطأ أثناء معالجة الطلب.**', ephemeral: true });
            }
        }
    });

    // Handle status selection
    collector.on('collect', async interaction => {
        if (interaction.customId === 'vip_status_select') {
            const activityType = interaction.values[0];

            const modal = new ModalBuilder()
                .setCustomId(`activity_modal_${activityType}`)
                .setTitle('Bot Status Settings');

            const statusInput = new TextInputBuilder()
                .setCustomId('activity_text')
                .setLabel('النص المراد عرضه')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(128)
                .setPlaceholder('أدخل النص...');

            const actionRow = new ActionRowBuilder().addComponents(statusInput);
            modal.addComponents(actionRow);

            // إضافة حقل URL للـ Streaming فقط
            if (activityType === 'streaming') {
                const urlInput = new TextInputBuilder()
                    .setCustomId('stream_url')
                    .setLabel('رابط البث (اختياري)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setMaxLength(200)
                    .setValue('https://www.twitch.tv/default')
                    .setPlaceholder('https://www.twitch.tv/your_channel');

                const urlRow = new ActionRowBuilder().addComponents(urlInput);
                modal.addComponents(urlRow);
            }

            await interaction.showModal(modal);
            return;
        }
    });

    // Handle modal submissions
    client.on('interactionCreate', async interaction => {
        if (!interaction.isModalSubmit()) return;
        if (interaction.user.id !== message.author.id) return;

        try {
            if (interaction.customId === 'change_name_modal') {
                const newName = interaction.fields.getTextInputValue('bot_name').trim();

                if (!newName) {
                    return interaction.reply({ content: '**يجب إدخال اسم صالح !**', ephemeral: true });
                }

                try {
                    await client.user.setUsername(newName);

                    logEvent(client, message.guild, {
                        type: 'ADMIN_ACTIONS',
                        title: 'Bot Name Changed',
                        description: 'The bot name has been updated',
                        user: message.author,
                        fields: [
                            { name: 'New Name', value: newName, inline: true }
                        ]
                    });

                    const successEmbed = colorManager.createEmbed()
                        .setDescription(`**✅ Complete change  ${newName}**`)
                        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400645490118234132/download__8_-removebg-preview.png?ex=688d6443&is=688c12c3&hm=217945651e6a5f649ede7719b4572da60d009a8aa461a507b72e2f82ea59a4cd&');

                    await interaction.reply({ embeds: [successEmbed], ephemeral: true });

                } catch (error) {
                    console.error('Error changing bot name:', error);
                    const errorEmbed = colorManager.createEmbed()
                        .setDescription('**❌ حدث خطأ أثناء تغيير الاسم ! قد تحتاج للانتظار قبل تغيير الاسم مرة أخرى.**')
                        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390888416608286/download__3_-removebg-preview.png?ex=688d1fe5&is=688bce65&hm=55055a587668561ce27baf0665663f801e14662d4bf849351564a563b1e53b41&');

                    await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
                }

            } else if (interaction.customId.startsWith('activity_modal_')) {
                const activityType = interaction.customId.replace('activity_modal_', '');
                const activityText = interaction.fields.getTextInputValue('activity_text').trim();

                if (!activityText) {
                    return interaction.reply({ content: '**يجب إدخال نص للحالة!**', ephemeral: true });
                }

                try {
                    const activityTypes = {
                        'playing': ActivityType.Playing,
                        'watching': ActivityType.Watching,
                        'listening': ActivityType.Listening,
                        'streaming': ActivityType.Streaming,
                        'competing': ActivityType.Competing
                    };

                    const presenceOptions = {
                        activities: [{
                            name: activityText,
                            type: activityTypes[activityType]
                        }],
                        status: 'online'
                    };

                    // إضافة URL للـ Streaming
                    if (activityType === 'streaming') {
                        const streamUrl = interaction.fields.getTextInputValue('stream_url')?.trim() || 'https://www.twitch.tv/default';
                        presenceOptions.activities[0].url = streamUrl;
                    }

                    await client.user.setPresence(presenceOptions);

                    saveBotStatus({
                        status: presenceOptions.status || 'online',
                        activityText: activityText,
                        activityType: activityTypes[activityType],
                        streamUrl: activityType === 'streaming' ? presenceOptions.activities[0].url : null
                    });

                    const activityLabels = {
                        'playing': 'يلعب',
                        'watching': 'يشاهد',
                        'listening': 'يستمع',
                        'streaming': 'يبث مباشر',
                        'competing': 'يتنافس'
                    };

                    logEvent(client, message.guild, {
                        type: 'ADMIN_ACTIONS',
                        title: 'Bot Status Changed',
                        description: 'The bot status has been updated',
                        user: message.author,
                        fields: [
                            { name: 'Status Type', value: activityLabels[activityType], inline: true },
                            { name: 'Status Text', value: activityText, inline: true },
                            ...(activityType === 'streaming' ? [{ name: 'Stream URL', value: presenceOptions.activities[0].url, inline: false }] : [])
                        ]
                    });

                    const successEmbed = colorManager.createEmbed()
                        .setDescription(`**✅ تم تغيير الحالة بنجاح**\n**النوع:** ${activityLabels[activityType]}\n**النص:** ${activityText}${activityType === 'streaming' ? `\n**الرابط:** ${presenceOptions.activities[0].url}` : ''}`)
                        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400645490118234132/download__8_-removebg-preview.png?ex=688d6443&is=688c12c3&hm=217945651e6a5f649ede7719b4572da60d009a8aa461a507b72e2f82ea59a4cd&');

                    await interaction.reply({ embeds: [successEmbed], ephemeral: true });

                } catch (error) {
                    console.error('Error changing bot status:', error);
                    const errorEmbed = colorManager.createEmbed()
                        .setDescription('**❌ حدث خطأ أثناء تغيير الحالة!**')
                        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390888416608286/download__3_-removebg-preview.png?ex=688d1fe5&is=688bce65&hm=55055a587668561ce27baf0665663f801e14662d4bf849351564a63b1e53b41&');

                    await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
                }

            } else if (interaction.customId === 'change_prefix_modal') {
                const newPrefixInput = interaction.fields.getTextInputValue('bot_prefix').trim();
                let newPrefix;

                // إذا كان الإدخال فارغ
                if (newPrefixInput === '') {
                    // إذا كان يوجد بريفكس حالياً، ضع null (بدون بريفكس)
                    if (currentPrefix !== null) {
                        newPrefix = null;
                    } else {
                        // إذا كان null حالياً، ضع " " (مسافة)
                        newPrefix = " ";
                    }
                } else {
                    // إذا تم إدخال نص، استخدمه كما هو
                    newPrefix = newPrefixInput;
                }

                // قراءة الكونفق الحالي وتحديثه
                const fs = require('fs');
                const path = require('path');
                const botConfigFile = path.join(__dirname, '..', 'data', 'botConfig.json');

                try {
                    let botConfig = {};
                    if (fs.existsSync(botConfigFile)) {
                        const data = fs.readFileSync(botConfigFile, 'utf8');
                        botConfig = JSON.parse(data);
                    }

                    // تحديث البريفكس في الكونفق مع وضع علامات التنصيص
                    if (newPrefix === null) {
                        botConfig.prefix = null;
                    } else {
                        botConfig.prefix = newPrefix;
                    }

                    // حفظ الكونفق المحدث
                    fs.writeFileSync(botConfigFile, JSON.stringify(botConfig, null, 2));

                    // استخدام الدالة العامة أيضاً للتأكيد
                    if (global.updatePrefix) {
                        global.updatePrefix(newPrefix);
                    }

                    // تحديث البريفكس المحلي في الأمر
                    currentPrefix = newPrefix;

                    const prefixDisplay = newPrefix === null ? 'null (بدون بريفكس)' : 
                                        newPrefix === ' ' ? '" " (مسافة)' : 
                                        `"${newPrefix}"`;

                    const configPrefixDisplay = newPrefix === null ? 'null' : `"${newPrefix}"`;

                    const successEmbed = colorManager.createEmbed()
                        .setDescription(`**✅ تم تغيير البريفكس إلى ${prefixDisplay} بنجاح!**\n**محفوظ في الكونفق كـ:** ${configPrefixDisplay}`)
                        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400645490118234132/download__8_-removebg-preview.png?ex=688d6443&is=688c12c3&hm=217945651e6a5f649ede7719b4572da60d009a8aa461a507b72e2f82ea59a4cd&');

                    await interaction.reply({ embeds: [successEmbed], ephemeral: true });

                    console.log(`✅ تم حفظ البريفكس الجديد في botConfig.json: ${newPrefix === null ? 'null' : newPrefix}`);

                } catch (error) {
                    console.error('❌ خطأ في حفظ البريفكس:', error);
                    const errorEmbed = colorManager.createEmbed()
                        .setDescription('**❌ حدث خطأ في تحديث وحفظ البريفكس!**')
                        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390888416608286/download__3_-removebg-preview.png?ex=688d1fe5&is=688bce65&hm=55055a587668561ce27baf0665663f801e14662d4bf849351564a563b1e53b41&');

                    await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
                }
            }

        } catch (error) {
            console.error('Error processing modal submission:', error);
            if (!interaction.replied) {
                await interaction.reply({ content: '**حدث خطأ أثناء معالجة الطلب.**', ephemeral: true });
            }
        }
    });

    collector.on('end', () => {
        sentMessage.edit({ components: [] }).catch(() => { });
    });
}

function restoreBotStatus(client) {
    try {
        const savedStatus = loadBotStatus();

        if (savedStatus.activityText && savedStatus.status !== 'offline') {
            if (savedStatus.activityType === ActivityType.Streaming) {
                client.user.setActivity(savedStatus.activityText, {
                    type: ActivityType.Streaming,
                    url: savedStatus.streamUrl || 'https://www.twitch.tv/example'
                });
            } else if (savedStatus.activityType === ActivityType.Watching) {
                client.user.setActivity(savedStatus.activityText, { type: ActivityType.Watching });
            } else if (savedStatus.activityType === ActivityType.Listening) {
                client.user.setActivity(savedStatus.activityText, { type: ActivityType.Listening });
            }
        }

        client.user.setStatus(savedStatus.status);

        console.log(`✅ تم استعادة حالة البوت: ${savedStatus.status} - ${savedStatus.activityText || 'بدون نشاط'}`);
    } catch (error) {
        console.error('خطأ في استعادة حالة البوت:', error);
    }
}

module.exports = { name, execute, restoreBotStatus };
