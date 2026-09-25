const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { isUserBlocked } = require('./block.js');
const moment = require('moment-timezone');
const fs = require('fs');
const path = require('path');
const { getDataDir, getBotConfigPath } = require('../utils/storagePaths');

const name = 'rooms';

function formatTimeSince(timestamp) {
    if (!timestamp) return 'No Data';

    const now = Date.now();
    const diff = now - new Date(timestamp).getTime();

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 && days === 0) parts.push(`${minutes}m`);
    if (seconds > 0 && days === 0 && hours === 0) parts.push(`${seconds}s`);

    return parts.length > 0 ? parts.join(' ') + ' ago' : 'Now';
}

function formatDuration(milliseconds) {
    if (!milliseconds || milliseconds <= 0) return '**لا يوجد**';

    const totalSeconds = Math.floor(milliseconds / 1000);
    const totalMinutes = Math.floor(totalSeconds / 60);
    const totalHours = Math.floor(totalMinutes / 60);
    const days = Math.floor(totalHours / 24);

    const hours = totalHours % 24;
    const minutes = totalMinutes % 60;

    const parts = [];
    if (days > 0) parts.push(`**${days}** d`);
    if (hours > 0) parts.push(`**${hours}** h`);
    if (minutes > 0) parts.push(`**${minutes}** m`);

    return parts.length > 0 ? parts.join(' و ') : '**أقل من دقيقة**';
}

function normalizeName(value) {
    return (value || '').toLowerCase().replace(/\s+/g, '');
}

function findBestRoleMatch(roles, searchTerm) {
    const normalizedSearch = normalizeName(searchTerm);
    return roles.find(role => normalizeName(role.name) === normalizedSearch)
        || roles.find(role => normalizeName(role.name).startsWith(normalizedSearch))
        || roles.find(role => normalizeName(role.name).includes(normalizedSearch));
}

function findBestMemberMatch(members, searchTerm) {
    const normalizedSearch = normalizeName(searchTerm);
    const getDisplayName = member => normalizeName(member.displayName);
    const getUsername = member => normalizeName(member.user.username);
    return members.find(member => getDisplayName(member) === normalizedSearch || getUsername(member) === normalizedSearch)
        || members.find(member => getDisplayName(member).startsWith(normalizedSearch) || getUsername(member).startsWith(normalizedSearch))
        || members.find(member => getDisplayName(member).includes(normalizedSearch) || getUsername(member).includes(normalizedSearch));
}

async function mapWithConcurrency(items, limit, mapper) {
    const results = [];
    for (let i = 0; i < items.length; i += limit) {
        const batch = items.slice(i, i + limit);
        const batchResults = await Promise.all(batch.map(mapper));
        results.push(...batchResults);
    }
    return results;
}

async function getUserActivity(userId) {
    try {
        const { getDatabase } = require('../utils/database');
        const dbManager = getDatabase();

        const stats = await dbManager.getUserStats(userId);
        const weeklyStats = await dbManager.getWeeklyStats(userId);

        const lastVoiceSession = await dbManager.get(`
            SELECT end_time, channel_name 
            FROM voice_sessions 
            WHERE user_id = ? 
            ORDER BY end_time DESC 
            LIMIT 1
        `, [userId]);

        const lastMessage = await dbManager.get(`
            SELECT last_message, channel_name 
            FROM message_channels 
            WHERE user_id = ? 
            ORDER BY last_message DESC 
            LIMIT 1
        `, [userId]);

        const activeSessions = (global.client && global.client.voiceSessions) || new Map();
        let liveDuration = 0;
        if (activeSessions.has(userId)) {
            const session = activeSessions.get(userId);
            if (session && !session.isAFK) {
                const liveStart = session.lastTrackedTime || session.startTime || session.sessionStartTime;
                liveDuration = Math.max(0, Date.now() - liveStart);
            }
        }

        return {
            totalMessages: stats.totalMessages || 0,
            totalVoiceTime: (stats.totalVoiceTime || 0) + liveDuration,
            weeklyMessages: weeklyStats.weeklyMessages || 0,
            weeklyVoiceTime: (weeklyStats.weeklyTime || 0) + liveDuration,
            lastVoiceTime: lastVoiceSession ? lastVoiceSession.end_time : null,
            lastVoiceChannel: lastVoiceSession ? lastVoiceSession.channel_name : null,
            lastMessageTime: lastMessage ? lastMessage.last_message : null,
            lastMessageChannel: lastMessage ? lastMessage.channel_name : null
        };
    } catch (error) {
        console.error('خطأ في جلب نشاط المستخدم:', error);
        return {
            totalMessages: 0,
            totalVoiceTime: 0,
            weeklyMessages: 0,
            weeklyVoiceTime: 0,
            lastVoiceTime: null,
            lastVoiceChannel: null,
            lastMessageTime: null,
            lastMessageChannel: null
        };
    }
}

async function execute(message, args, { client, BOT_OWNERS, ADMIN_ROLES }) {
    if (isUserBlocked(message.author.id)) {
        const blockedEmbed = colorManager.createEmbed()
            .setDescription('**🚫 أنت محظور من استخدام أوامر البوت**\n**للاستفسار، تواصل مع إدارة السيرفر**')
            .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));
        await message.channel.send({ embeds: [blockedEmbed] });
        return;
    }

    const member = await message.guild.members.fetch(message.author.id);
    const hasAdministrator = member.permissions.has('Administrator');
    const isOwner = BOT_OWNERS.includes(message.author.id);
    
    // Check if user has an allowed role
    const botConfig = JSON.parse(fs.readFileSync(getBotConfigPath(), 'utf8'));
    const allowedRoles = botConfig.roomsAllowedRoles || [];
    const hasAllowedRole = member.roles.cache.some(role => allowedRoles.includes(role.id));

    if (args[0] && args[0].toLowerCase() === 'allow') {
        if (!isOwner) return message.react('❌');
        
        let roleToAllow = message.mentions.roles.first() || message.guild.roles.cache.get(args[1]);
        if (!roleToAllow) return message.reply('**الرجاء منشن رول أو كتابة ID الرول المسموح له**');
        
        if (!botConfig.roomsAllowedRoles) botConfig.roomsAllowedRoles = [];
        if (!botConfig.roomsAllowedRoles.includes(roleToAllow.id)) {
            botConfig.roomsAllowedRoles.push(roleToAllow.id);
            fs.writeFileSync(getBotConfigPath(), JSON.stringify(botConfig, null, 2));
            return message.reply(`**✅ تم السماح للرول ${roleToAllow.name} باستخدام أمر rooms**`);
        } else {
            return message.reply(`**⚠️ الرول ${roleToAllow.name} مسموح له بالفعل**`);
        }
    }

    if (!hasAdministrator && !hasAllowedRole) {
        await message.react('❌');
        return;
    }

    // التحقق من أمر admin
    if (args[0] && args[0].toLowerCase() === 'admin') {
        await showAdminRolesActivity(message, client, ADMIN_ROLES);
        return;
    }

    let targetRole = message.mentions.roles.first();
    let targetUser = message.mentions.users.first();

    // إذا لم يكن هناك منشن، تحقق من ID
    if (!targetRole && !targetUser && args[0]) {
        const id = args[0];

        // محاولة البحث عن رول بالـ ID
        try {
            targetRole = await message.guild.roles.fetch(id);
        } catch (error) {
            // ليس رول، جرب مستخدم
        }

        // إذا لم يكن رول، جرب مستخدم
        if (!targetRole) {
            try {
                const fetchedMember = await message.guild.members.fetch(id);
                targetUser = fetchedMember.user;
            } catch (error) {
                // ليس مستخدم أيضاً
            }
        }
    }

    if (!targetRole && !targetUser && args.length > 0) {
        const searchTerm = args.join(' ');
        const roleByName = findBestRoleMatch(message.guild.roles.cache, searchTerm);
        const memberByName = findBestMemberMatch(message.guild.members.cache, searchTerm);

        if (roleByName) {
            targetRole = roleByName;
        } else if (memberByName) {
            targetUser = memberByName.user;
        }
    }

    if (!targetRole && !targetUser) {
        const embed = colorManager.createEmbed()
            .setTitle('**Rooms System**')
            .setDescription('**الرجاء منشن رول أو عضو أو كتابة ID أو الاسم**\n\n**أمثلة :**\n`rooms @Role`\n`rooms @User`\n`rooms 636930315503534110`\n`rooms اسم-العضو`\n`rooms admin` - لعرض جميع الأدمن')
            .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

        await message.channel.send({ embeds: [embed] });
        return;
    }

    if (targetUser) {
        await showUserActivity(message, targetUser, client);
    } else {
        await showRoleActivity(message, targetRole, client);
    }
}

async function showUserActivity(message, user, client) {
    try {
        const member = await message.guild.members.fetch(user.id);
        const activity = await getUserActivity(user.id);

        let lastVoiceInfo = '**No Data**';
        if (activity.lastVoiceChannel) {
            const voiceChannel = message.guild.channels.cache.find(ch => ch.name === activity.lastVoiceChannel);
            const channelMention = voiceChannel ? `<#${voiceChannel.id}>` : `**${activity.lastVoiceChannel}**`;
            const timeAgo = formatTimeSince(activity.lastVoiceTime);
            lastVoiceInfo = `${channelMention} - \`${timeAgo}\``;
        }

        let lastMessageInfo = '**No Data**';
        if (activity.lastMessageChannel) {
            const textChannel = message.guild.channels.cache.find(ch => ch.name === activity.lastMessageChannel);
            const channelMention = textChannel ? `<#${textChannel.id}>` : `**${activity.lastMessageChannel}**`;
            const timeAgo = formatTimeSince(activity.lastMessageTime);
            lastMessageInfo = `${channelMention} - \`${timeAgo}\``;
        }

        const embed = colorManager.createEmbed()
            .setTitle(`**User Activity**`)
            .setThumbnail(user.displayAvatarURL({ dynamic: true }))
            .setDescription(`** User :** ${user}`)
            .addFields([
                { name: '**<:emoji_7:1429246526949036212> Last voice room **', value: lastVoiceInfo, inline: false },
                { name: '**<:emoji_8:1429246555726020699> Last Text Room**', value: lastMessageInfo, inline: false }
            ])
            .setFooter({ text: `By Ahmed.`, iconURL: message.guild.iconURL({ dynamic: true }) })
            .setTimestamp();

        await message.channel.send({ embeds: [embed] });
    } catch (error) {
        console.error('خطأ في عرض نشاط المستخدم:', error);
        await message.channel.send({ content: '**حدث خطأ أثناء جلب البيانات**' });
    }
}

async function showAdminRolesActivity(message, client, ADMIN_ROLES) {
    try {
        // جمع جميع الأعضاء من جميع رولات الأدمن
        const allAdminMembers = new Map();

        for (const roleId of ADMIN_ROLES) {
            try {
                const role = await message.guild.roles.fetch(roleId);
                if (role && role.members) {
                    for (const [memberId, member] of role.members) {
                        if (!member.user.bot) {
                            allAdminMembers.set(memberId, member);
                        }
                    }
                }
            } catch (error) {
                console.error(`خطأ في جلب الرول ${roleId}:`, error);
            }
        }

        if (allAdminMembers.size === 0) {
            const embed = colorManager.createEmbed()
                .setDescription('**No Admins يادلخ**')
                .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));
            await message.channel.send({ embeds: [embed] });
            return;
        }

        const memberEntries = [...allAdminMembers.entries()];
        const memberActivities = (await mapWithConcurrency(memberEntries, 10, async ([userId, member]) => {
            const activity = await getUserActivity(userId);
            const totalActivity = activity.totalMessages + (activity.totalVoiceTime / 60000);

            return {
                member: member,
                activity: activity,
                totalActivity: totalActivity,
                xp: Math.floor(activity.totalMessages / 10)
            };
        })).filter(Boolean);

        memberActivities.sort((a, b) => b.totalActivity - a.totalActivity);

        let currentPage = 0;
        const itemsPerPage = 10;
        const totalPages = Math.ceil(memberActivities.length / itemsPerPage);

        const generateEmbed = (page) => {
            const start = page * itemsPerPage;
            const end = Math.min(start + itemsPerPage, memberActivities.length);
            const pageMembers = memberActivities.slice(start, end);

            const embed = colorManager.createEmbed()
                .setTitle(`**Rooms : Admin Roles**`)
                .setDescription(`** All members :** ${memberActivities.length}`)
                .setFooter({ text: `By Ahmed. | صفحة ${page + 1} من ${totalPages}`, iconURL: message.guild.iconURL({ dynamic: true }) })
                .setTimestamp();

            pageMembers.forEach((data, index) => {
                const globalRank = start + index + 1;
                const member = data.member;
                const activity = data.activity;

                let lastVoiceInfo = '**No Data**';
                if (activity.lastVoiceChannel) {
                    const voiceChannel = message.guild.channels.cache.find(ch => ch.name === activity.lastVoiceChannel);
                    const channelMention = voiceChannel ? `<#${voiceChannel.id}>` : `**${activity.lastVoiceChannel}**`;
                    const timeAgo = formatTimeSince(activity.lastVoiceTime);
                    lastVoiceInfo = `${channelMention} - \`${timeAgo}\``;
                }

                let lastMessageInfo = '**No Data**';
                if (activity.lastMessageChannel) {
                    const textChannel = message.guild.channels.cache.find(ch => ch.name === activity.lastMessageChannel);
                    const channelMention = textChannel ? `<#${textChannel.id}>` : `**${activity.lastMessageChannel}**`;
                    const timeAgo = formatTimeSince(activity.lastMessageTime);
                    lastMessageInfo = `${channelMention} - \`${timeAgo}\``;
                }

                embed.addFields([{
                    name: `**#${globalRank} - ${member.displayName}**`,
                    value: `> **<:emoji_7:1429246526949036212> Last Voice :** ${lastVoiceInfo}\n` +
                           `> **<:emoji_8:1429246555726020699> Last Text :** ${lastMessageInfo}`,
                    inline: false
                }]);
            });

            return embed;
        };

        const generateButtons = (page) => {
            const row1 = new ActionRowBuilder();

            const leftButton = new ButtonBuilder()
                .setCustomId('rooms_previous')
                .setEmoji('<:emoji_13:1429263136136888501>')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(page === 0);

            const rightButton = new ButtonBuilder()
                .setCustomId('rooms_next')
                .setEmoji('<:emoji_14:1429263186539974708>')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(page === totalPages - 1);

            row1.addComponents(leftButton, rightButton);

            const row2 = new ActionRowBuilder();

            const mentionButton = new ButtonBuilder()
                .setCustomId('rooms_mention')
                .setLabel('Mention')
.setEmoji('<:emoji_52:1430734157885210654>')
                .setStyle(ButtonStyle.Secondary);

            const notifyButton = new ButtonBuilder()
                .setCustomId('rooms_notify')
                .setLabel('Notify')
.setEmoji('<:emoji_53:1430740078321209365>')
                .setStyle(ButtonStyle.Secondary);

            row2.addComponents(mentionButton, notifyButton);

            return [row1, row2];
        };

        const sentMessage = await message.channel.send({
            embeds: [generateEmbed(currentPage)],
            components: generateButtons(currentPage)
        });

        const filter = i => i.user.id === message.author.id;
        const collector = sentMessage.createMessageComponentCollector({ filter, time: 300000 });

        let isNotifyInProgress = false;

        collector.on('collect', async interaction => {
            console.log(`🔘 تم الضغط على زر: ${interaction.customId} من قبل ${interaction.user.tag}`);

            try {
                if (interaction.customId === 'rooms_previous') {
                    if (interaction.replied || interaction.deferred) return;
                    currentPage = Math.max(0, currentPage - 1);
                    await interaction.update({
                        embeds: [generateEmbed(currentPage)],
                        components: generateButtons(currentPage)
                    });
                } else if (interaction.customId === 'rooms_next') {
                    if (interaction.replied || interaction.deferred) return;
                    currentPage = Math.min(totalPages - 1, currentPage + 1);
                    await interaction.update({
                        embeds: [generateEmbed(currentPage)],
                        components: generateButtons(currentPage)
                    });
                } else if (interaction.customId === 'rooms_mention') {
                    if (interaction.replied || interaction.deferred) return;
                    
                    // فلترة الأعضاء - استبعاد الموجودين في الرومات الصوتية
                    const membersToMention = [];
                    for (const data of memberActivities) {
                        try {
                            const freshMember = await message.guild.members.fetch(data.member.id, { force: true });
                            const isInVoice = freshMember.voice && 
                                            freshMember.voice.channelId && 
                                            freshMember.voice.channel !== null &&
                                            message.guild.channels.cache.has(freshMember.voice.channelId);
                            
                            if (!isInVoice) {
                                membersToMention.push(data.member.id);
                            }
                        } catch (error) {
                            // إذا فشل جلب العضو، نضيفه للقائمة احتياطياً
                            membersToMention.push(data.member.id);
                        }
                    }
                    
                    // تقسيم المنشنات إلى مجموعات لتجنب تجاوز حد 2000 حرف
                    const mentions = membersToMention.map(id => `<@${id}>`);
                    const mentionChunks = [];
                    let currentChunk = '';
                    
                    for (const mention of mentions) {
                        if ((currentChunk + mention + ' ').length > 1900) { // ترك مساحة آمنة
                            mentionChunks.push(currentChunk.trim());
                            currentChunk = mention + ' ';
                        } else {
                            currentChunk += mention + ' ';
                        }
                    }
                    if (currentChunk.trim()) {
                        mentionChunks.push(currentChunk.trim());
                    }

                    const skippedCount = memberActivities.length - membersToMention.length;
                    const mentionEmbed = colorManager.createEmbed()
                        .setTitle(`**Admin Roles**`)
                        .setDescription(`**تم منشن ${membersToMention.length} عضو من رولات الأدمن**\n**تم استبعاد ${skippedCount} عضو (في الرومات الصوتية)**\n**عدد الرسائل:** ${mentionChunks.length}`)
                        .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }))
                        .setFooter({ text: 'By Ahmed.' })
                        .setTimestamp();

                    // إرسال أول رسالة كـ update
                    await interaction.update({
                        content: mentionChunks[0] || 'لا يوجد أعضاء للمنشن (جميعهم في الرومات الصوتية)',
                        embeds: [mentionEmbed],
                        components: generateButtons(currentPage)
                    });
                    
                    // إرسال باقي الرسائل كرسائل منفصلة
                    for (let i = 1; i < mentionChunks.length; i++) {
                        await interaction.channel.send({
                            content: mentionChunks[i]
                        });
                    }
                } else if (interaction.customId === 'rooms_notify') {
                    console.log(`🔔 بدء معالجة زر التنبيه للأدمن - حالة: replied=${interaction.replied}, deferred=${interaction.deferred}, inProgress=${isNotifyInProgress}`);

                    if (interaction.replied || interaction.deferred) {
                        console.log('⚠️ تم تجاهل ضغطة زر تنبيه - التفاعل معالج مسبقاً');
                        await interaction.reply({ 
                            content: '**⏳ يوجد عملية إرسال تنبيهات جارية حالياً، الرجاء الانتظار**', 
                            ephemeral: true 
                        }).catch(() => {});
                        return;
                    }

                    if (isNotifyInProgress) {
                        console.log('⚠️ عملية تنبيه قيد التنفيذ بالفعل');
                        await interaction.reply({ 
                            content: '**⏳ يوجد عملية إرسال تنبيهات جارية حالياً، الرجاء الانتظار**', 
                            ephemeral: true 
                        }).catch(() => {});
                        return;
                    }

                    isNotifyInProgress = true;
                    console.log('✅ تم تعيين isNotifyInProgress = true');

                    try {
                        const updatedButtons = generateButtons(currentPage);
                        const notifyButtonRow = updatedButtons[1];
                        const notifyButton = notifyButtonRow.components.find(btn => btn.data.custom_id === 'rooms_notify');
                        if (notifyButton) {
                            notifyButton.setLabel('Notified').setEmoji('<:emoji_42:1430334150057001042>').setDisabled(true).setStyle(ButtonStyle.Secondary);
                        }

                        await interaction.update({
                            embeds: [generateEmbed(currentPage)],
                            components: updatedButtons
                        });

                        await interaction.followUp({
                            content: '<:emoji_53:1430733925227171980>',
                            ephemeral: true
                        });

                        let successCount = 0;
                        let failCount = 0;
                        let skippedCount = 0;
                        let rateLimitedCount = 0;
                        let processedCount = 0;

                        // نظام Batching - معالجة 5 أعضاء في كل دفعة
                        const BATCH_SIZE = 5;
                        const BATCH_DELAY = 3000; // 3 ثواني بين كل دفعة
                        const MESSAGE_DELAY = 1200; // 1.2 ثانية بين كل رسالة
                        const MAX_RETRIES = 2;

                        // تقسيم الأعضاء إلى دفعات
                        const batches = [];
                        for (let i = 0; i < memberActivities.length; i += BATCH_SIZE) {
                            batches.push(memberActivities.slice(i, i + BATCH_SIZE));
                        }

                        console.log(`📦 تم تقسيم ${memberActivities.length} عضو إلى ${batches.length} دفعة`);

                        // دالة لإرسال رسالة مع إعادة محاولة
                        async function sendDMWithRetry(member, embed, retries = MAX_RETRIES) {
                            for (let attempt = 0; attempt <= retries; attempt++) {
                                try {
                                    await member.send({ embeds: [embed] });
                                    return { success: true };
                                } catch (error) {
                                    if (error.code === 429) {
                                        const retryAfter = error.retry_after || 2;
                                        console.warn(`⏳ Rate limit - انتظار ${retryAfter}s قبل إعادة المحاولة ${attempt + 1}/${retries}`);
                                        if (attempt < retries) {
                                            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                                            continue;
                                        }
                                        return { success: false, rateLimited: true };
                                    } else if (error.code === 50007) {
                                        // Cannot send messages to this user
                                        return { success: false, cannotDM: true };
                                    } else {
                                        return { success: false, error: error.message };
                                    }
                                }
                            }
                            return { success: false, rateLimited: true };
                        }

                        // معالجة كل دفعة
                        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
                            const batch = batches[batchIndex];
                            console.log(`📨 معالجة الدفعة ${batchIndex + 1}/${batches.length} (${batch.length} أعضاء)`);

                            // تحديث الرسالة المؤقتة كل 3 دفعات
                            if (batchIndex % 3 === 0) {
                                try {
                                    await interaction.editReply({
                                        content: `<:emoji_53:1430733925227171980>` ,
                                                
                                        ephemeral: true
                                    }).catch(() => {});
                                } catch (e) {}
                            }

                            for (const data of batch) {
                                try {
                                    const freshMember = await message.guild.members.fetch(data.member.id, { force: true });

                                    const isInVoice = freshMember.voice && 
                                                    freshMember.voice.channelId && 
                                                    freshMember.voice.channel !== null &&
                                                    message.guild.channels.cache.has(freshMember.voice.channelId);

                                    if (isInVoice) {
                                        skippedCount++;
                                        const channelName = freshMember.voice.channel?.name || 'Unknown';
                                        console.log(`⏭️ تم استبعاد ${freshMember.displayName} لأنه في الرومات الصوتية: ${channelName}`);
                                    } else {
                                        const dmEmbed = colorManager.createEmbed()
                                            .setTitle('**تنبيه من إدارة السيرفر**')
                                            .setDescription(`**🔔 الرجاء التفاعل في الرومات**\n\n**السيرفر :** ${message.guild.name}\n**الفئة :** **Admin Roles**`)
                                            .setThumbnail(message.guild.iconURL({ dynamic: true }))
                                            .setFooter({ text: 'By Ahmed.' })
                                            .setTimestamp();

                                        const result = await sendDMWithRetry(freshMember, dmEmbed);
                                        
                                        if (result.success) {
                                            successCount++;
                                            console.log(`✅ تم إرسال تنبيه لـ ${freshMember.displayName}`);
                                        } else if (result.rateLimited) {
                                            rateLimitedCount++;
                                            console.warn(`⚠️ Rate limited - ${freshMember.displayName}`);
                                        } else if (result.cannotDM) {
                                            failCount++;
                                            console.error(`❌ DMs مغلقة - ${freshMember.displayName}`);
                                        } else {
                                            failCount++;
                                            console.error(`❌ فشل الإرسال - ${freshMember.displayName}: ${result.error}`);
                                        }

                                        // تأخير بين كل رسالة
                                        await new Promise(resolve => setTimeout(resolve, MESSAGE_DELAY));
                                    }

                                    processedCount++;
                                } catch (error) {
                                    failCount++;
                                    processedCount++;
                                    console.error(`❌ فشل معالجة العضو ${data.member.displayName}:`, error.message);
                                }
                            }

                            // تأخير بين الدفعات (ما عدا الدفعة الأخيرة)
                            if (batchIndex < batches.length - 1) {
                                console.log(`⏸️ انتظار ${BATCH_DELAY / 1000}s قبل الدفعة التالية...`);
                                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
                            }
                        }

                        const finalMessage = `** Finished ** \n\n` +
                            `**<:emoji_51:1430733243140931645> sended to :** ${successCount}\n` +
                            `**<:emoji_2:1430777126570688703> failed to :** ${failCount}\n` +
                            `**<:emoji_2:1430777099744055346> in rooms :** ${skippedCount}\n` +
                            (rateLimitedCount > 0 ? `**<:emoji_53:1430733925227171980> Rate Limited :** ${rateLimitedCount}\n` : '') +
                            `\n**<:emoji_52:1430734346461122654> members :** ${memberActivities.length}\n` +
                            `**<:emoji_51:1430733172710183103> Final :** ${Math.round((successCount / Math.max(memberActivities.length - skippedCount, 1)) * 100)}%`;

                        try {
                            await interaction.followUp({
                                content: finalMessage,
                                ephemeral: true
                            });
                        } catch (error) {
                            console.error('خطأ في إرسال الرسالة النهائية:', error);
                        }

                        console.log('✅ تم الانتهاء من إرسال التنبيهات بنجاح');
                    } catch (notifyError) {
                        console.error('❌ خطأ في معالج التنبيه:', notifyError);
                        try {
                            await interaction.followUp({
                                content: `**❌ حدث خطأ أثناء إرسال التنبيهات**\n\n**السبب:** ${notifyError.message || 'خطأ غير معروف'}`,
                                ephemeral: true
                            });
                        } catch (editError) {
                            console.error('خطأ في إرسال رسالة الخطأ:', editError);
                        }
                    } finally {
                        isNotifyInProgress = false;
                        console.log('🔓 تم إعادة تعيين isNotifyInProgress = false');
                    }
                }
            } catch (error) {
                console.error('خطأ في معالج الأزرار:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: '**حدث خطأ أثناء معالجة الطلب**', ephemeral: true });
                }
            }
        });

        collector.on('end', () => {
            sentMessage.edit({ components: [] }).catch(console.error);
        });

    } catch (error) {
        console.error('خطأ في عرض نشاط الأدمن:', error);
        await message.channel.send({ content: '**حدث خطأ أثناء جلب البيانات**' });
    }
}

async function showRoleActivity(message, role, client) {
    try {
        const members = role.members;

        if (members.size === 0) {
            const embed = colorManager.createEmbed()
                .setDescription('**No one in the role**')
                .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));
            await message.channel.send({ embeds: [embed] });
            return;
        }

        const memberEntries = [...members.entries()].filter(([, member]) => !member.user.bot);
        const memberActivities = (await mapWithConcurrency(memberEntries, 10, async ([userId, member]) => {
            const activity = await getUserActivity(userId);
            const totalActivity = activity.totalMessages + (activity.totalVoiceTime / 60000);

            return {
                member: member,
                activity: activity,
                totalActivity: totalActivity,
                xp: Math.floor(activity.totalMessages / 10)
            };
        })).filter(Boolean);

        memberActivities.sort((a, b) => b.totalActivity - a.totalActivity);

        let currentPage = 0;
        const itemsPerPage = 10;
        const totalPages = Math.ceil(memberActivities.length / itemsPerPage);

        const generateEmbed = (page) => {
            const start = page * itemsPerPage;
            const end = Math.min(start + itemsPerPage, memberActivities.length);
            const pageMembers = memberActivities.slice(start, end);

            const embed = colorManager.createEmbed()
                .setTitle(`**Rooms : ${role.name}**`)
                .setDescription(`** All members :** ${memberActivities.length}`)
                .setFooter({ text: `By Ahmed. | صفحة ${page + 1} من ${totalPages}`, iconURL: message.guild.iconURL({ dynamic: true }) })
                .setTimestamp();

            pageMembers.forEach((data, index) => {
                const globalRank = start + index + 1;
                const member = data.member;
                const activity = data.activity;

                let lastVoiceInfo = '**No Data**';
                if (activity.lastVoiceChannel) {
                    const voiceChannel = message.guild.channels.cache.find(ch => ch.name === activity.lastVoiceChannel);
                    const channelMention = voiceChannel ? `<#${voiceChannel.id}>` : `**${activity.lastVoiceChannel}**`;
                    const timeAgo = formatTimeSince(activity.lastVoiceTime);
                    lastVoiceInfo = `${channelMention} - \`${timeAgo}\``;
                }

                let lastMessageInfo = '**No Data**';
                if (activity.lastMessageChannel) {
                    const textChannel = message.guild.channels.cache.find(ch => ch.name === activity.lastMessageChannel);
                    const channelMention = textChannel ? `<#${textChannel.id}>` : `**${activity.lastMessageChannel}**`;
                    const timeAgo = formatTimeSince(activity.lastMessageTime);
                    lastMessageInfo = `${channelMention} - \`${timeAgo}\``;
                }

                embed.addFields([{
                    name: `**#${globalRank} - ${member.displayName}**`,
                    value: `> **<:emoji_7:1429246526949036212> Last Voice :** ${lastVoiceInfo}\n` +
                           `> **<:emoji_8:1429246555726020699> Last Text :** ${lastMessageInfo}`,
                    inline: false
                }]);
            });

            return embed;
        };

        const generateButtons = (page) => {
            const row1 = new ActionRowBuilder();

            const leftButton = new ButtonBuilder()
                .setCustomId('rooms_previous')
                .setEmoji('<:emoji_13:1429263136136888501>')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 0);

            const rightButton = new ButtonBuilder()
                .setCustomId('rooms_next')
                .setEmoji('<:emoji_14:1429263186539974708>')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === totalPages - 1);

            row1.addComponents(leftButton, rightButton);

            const row2 = new ActionRowBuilder();

            const mentionButton = new ButtonBuilder()
                .setCustomId('rooms_mention')
                .setLabel('Mention')
.setEmoji('<:emoji_52:1430734157885210654>')
                .setStyle(ButtonStyle.Secondary);

            const notifyButton = new ButtonBuilder()
                .setCustomId('rooms_notify')
                .setLabel('Notify')
.setEmoji('<:emoji_53:1430740078321209365>')
                .setStyle(ButtonStyle.Secondary);

            row2.addComponents(mentionButton, notifyButton);

            return [row1, row2];
        };

        const sentMessage = await message.channel.send({
            embeds: [generateEmbed(currentPage)],
            components: generateButtons(currentPage)
        });

        const filter = i => i.user.id === message.author.id;
        const collector = sentMessage.createMessageComponentCollector({ filter, time: 300000 });

        let isNotifyInProgress = false;

        collector.on('collect', async interaction => {
            console.log(`🔘 تم الضغط على زر: ${interaction.customId} من قبل ${interaction.user.tag}`);

            try {
                if (interaction.customId === 'rooms_previous') {
                    if (interaction.replied || interaction.deferred) return;
                    currentPage = Math.max(0, currentPage - 1);
                    await interaction.update({
                        embeds: [generateEmbed(currentPage)],
                        components: generateButtons(currentPage)
                    });
                } else if (interaction.customId === 'rooms_next') {
                    if (interaction.replied || interaction.deferred) return;
                    currentPage = Math.min(totalPages - 1, currentPage + 1);
                    await interaction.update({
                        embeds: [generateEmbed(currentPage)],
                        components: generateButtons(currentPage)
                    });
                } else if (interaction.customId === 'rooms_mention') {
                    if (interaction.replied || interaction.deferred) return;
                    
                    // فلترة الأعضاء - استبعاد الموجودين في الرومات الصوتية
                    const membersToMention = [];
                    for (const data of memberActivities) {
                        try {
                            const freshMember = await message.guild.members.fetch(data.member.id, { force: true });
                            const isInVoice = freshMember.voice && 
                                            freshMember.voice.channelId && 
                                            freshMember.voice.channel !== null &&
                                            message.guild.channels.cache.has(freshMember.voice.channelId);
                            
                            if (!isInVoice) {
                                membersToMention.push(data.member.id);
                            }
                        } catch (error) {
                            // إذا فشل جلب العضو، نضيفه للقائمة احتياطياً
                            membersToMention.push(data.member.id);
                        }
                    }
                    
                    // تقسيم المنشنات إلى مجموعات لتجنب تجاوز حد 2000 حرف
                    const mentions = membersToMention.map(id => `<@${id}>`);
                    const mentionChunks = [];
                    let currentChunk = '';
                    
                    for (const mention of mentions) {
                        if ((currentChunk + mention + ' ').length > 1900) { // ترك مساحة آمنة
                            mentionChunks.push(currentChunk.trim());
                            currentChunk = mention + ' ';
                        } else {
                            currentChunk += mention + ' ';
                        }
                    }
                    if (currentChunk.trim()) {
                        mentionChunks.push(currentChunk.trim());
                    }

                    const skippedCount = memberActivities.length - membersToMention.length;
                    const mentionEmbed = colorManager.createEmbed()
                        .setTitle(`**Mention: ${role.name}**`)
                        .setDescription(`**تم منشن ${membersToMention.length} عضو من الرول**\n**تم استبعاد ${skippedCount} عضو (في الرومات الصوتية)**\n**عدد الرسائل:** ${mentionChunks.length}`)
                        .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }))
                        .setFooter({ text: 'By Ahmed.' })
                        .setTimestamp();

                    // إرسال أول رسالة كـ update
                    await interaction.update({
                        content: mentionChunks[0] || 'لا يوجد أعضاء للمنشن (جميعهم في الرومات الصوتية)',
                        embeds: [mentionEmbed],
                        components: generateButtons(currentPage)
                    });
                    
                    // إرسال باقي الرسائل كرسائل منفصلة
                    for (let i = 1; i < mentionChunks.length; i++) {
                        await interaction.channel.send({
                            content: mentionChunks[i]
                        });
                    }
                } else if (interaction.customId === 'rooms_notify') {
                    console.log(`🔔 بدء معالجة زر التنبيه - حالة: replied=${interaction.replied}, deferred=${interaction.deferred}, inProgress=${isNotifyInProgress}`);

                    if (interaction.replied || interaction.deferred) {
                        console.log('⚠️ تم تجاهل ضغطة زر تنبيه - التفاعل معالج مسبقاً');
                        return;
                    }

                    if (isNotifyInProgress) {
                        console.log('⚠️ عملية تنبيه قيد التنفيذ بالفعل');
                        await interaction.reply({ 
                            content: '**⏳ يوجد عملية إرسال تنبيهات جارية حالياً، الرجاء الانتظار**', 
                            ephemeral: true 
                        }).catch(() => {});
                        return;
                    }

                    isNotifyInProgress = true;
                    console.log('✅ تم تعيين isNotifyInProgress = true');

                    try {
                        // تغيير نص الزر إلى "تم التنبيه" وتعطيله
                        const updatedButtons = generateButtons(currentPage);
                        const notifyButtonRow = updatedButtons[1];
                        const notifyButton = notifyButtonRow.components.find(btn => btn.data.custom_id === 'rooms_notify');
                        if (notifyButton) {
                            notifyButton.setLabel('Notified').setEmoji('<:emoji_42:1430334150057001042>').setDisabled(true).setStyle(ButtonStyle.Secondary);
                        }

                        await interaction.update({
                            embeds: [generateEmbed(currentPage)],
                            components: updatedButtons
                        });

                        // إرسال رسالة مخفية للمستخدم
                        await interaction.followUp({
                            content: '<:emoji_53:1430733925227171980>',
                            ephemeral: true
                        });

                        let successCount = 0;
                        let failCount = 0;
                        let skippedCount = 0;
                        let rateLimitedCount = 0;
                        let processedCount = 0;

                        // نظام Batching - معالجة 5 أعضاء في كل دفعة
                        const BATCH_SIZE = 5;
                        const BATCH_DELAY = 3000; // 3 ثواني بين كل دفعة
                        const MESSAGE_DELAY = 1200; // 1.2 ثانية بين كل رسالة
                        const MAX_RETRIES = 2;

                        // تقسيم الأعضاء إلى دفعات
                        const batches = [];
                        for (let i = 0; i < memberActivities.length; i += BATCH_SIZE) {
                            batches.push(memberActivities.slice(i, i + BATCH_SIZE));
                        }

                        console.log(`📦 تم تقسيم ${memberActivities.length} عضو إلى ${batches.length} دفعة`);

                        // دالة لإرسال رسالة مع إعادة محاولة
                        async function sendDMWithRetry(member, embed, retries = MAX_RETRIES) {
                            for (let attempt = 0; attempt <= retries; attempt++) {
                                try {
                                    await member.send({ embeds: [embed] });
                                    return { success: true };
                                } catch (error) {
                                    if (error.code === 429) {
                                        const retryAfter = error.retry_after || 2;
                                        console.warn(`⏳ Rate limit - انتظار ${retryAfter}s قبل إعادة المحاولة ${attempt + 1}/${retries}`);
                                        if (attempt < retries) {
                                            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                                            continue;
                                        }
                                        return { success: false, rateLimited: true };
                                    } else if (error.code === 50007) {
                                        return { success: false, cannotDM: true };
                                    } else {
                                        return { success: false, error: error.message };
                                    }
                                }
                            }
                            return { success: false, rateLimited: true };
                        }

                        // معالجة كل دفعة
                        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
                            const batch = batches[batchIndex];
                            console.log(`📨 معالجة الدفعة ${batchIndex + 1}/${batches.length} (${batch.length} أعضاء)`);

                            // تحديث الرسالة المؤقتة كل 3 دفعات
                            if (batchIndex % 3 === 0) {
                                try {
                                    await interaction.editReply({
                                        content: `<:emoji_53:1430733925227171980>`,
                                        ephemeral: true
                                    }).catch(() => {});
                                } catch (e) {}
                            }

                            for (const data of batch) {
                                try {
                                    const freshMember = await message.guild.members.fetch(data.member.id, { force: true });

                                    const isInVoice = freshMember.voice && 
                                                    freshMember.voice.channelId && 
                                                    freshMember.voice.channel !== null &&
                                                    message.guild.channels.cache.has(freshMember.voice.channelId);

                                    if (isInVoice) {
                                        skippedCount++;
                                        const channelName = freshMember.voice.channel?.name || 'Unknown';
                                        console.log(`⏭️ تم استبعاد ${freshMember.displayName} لأنه في الرومات الصوتية: ${channelName}`);
                                    } else {
                                        const dmEmbed = colorManager.createEmbed()
                                            .setTitle('**تنبيه من إدارة السيرفر**')
                                            .setDescription(`**🔔 الرجاء التفاعل في الرومات**\n\n**السيرفر :** ${message.guild.name}\n**الرول :** **${role.name}**`)
                                            .setThumbnail(message.guild.iconURL({ dynamic: true }))
                                            .setFooter({ text: 'By Ahmed.' })
                                            .setTimestamp();

                                        const result = await sendDMWithRetry(freshMember, dmEmbed);
                                        
                                        if (result.success) {
                                            successCount++;
                                            console.log(`✅ تم إرسال تنبيه لـ ${freshMember.displayName}`);
                                        } else if (result.rateLimited) {
                                            rateLimitedCount++;
                                            console.warn(`⚠️ Rate limited - ${freshMember.displayName}`);
                                        } else if (result.cannotDM) {
                                            failCount++;
                                            console.error(`❌ DMs مغلقة - ${freshMember.displayName}`);
                                        } else {
                                            failCount++;
                                            console.error(`❌ فشل الإرسال - ${freshMember.displayName}: ${result.error}`);
                                        }

                                        // تأخير بين كل رسالة
                                        await new Promise(resolve => setTimeout(resolve, MESSAGE_DELAY));
                                    }

                                    processedCount++;
                                } catch (error) {
                                    failCount++;
                                    processedCount++;
                                    console.error(`❌ فشل معالجة العضو ${data.member.displayName}:`, error.message);
                                }
                            }

                            // تأخير بين الدفعات (ما عدا الدفعة الأخيرة)
                            if (batchIndex < batches.length - 1) {
                                console.log(`⏸️ انتظار ${BATCH_DELAY / 1000}s قبل الدفعة التالية...`);
                                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
                            }
                        }

                        const finalMessage =` ** Finished ** \n\n `+
                            `**<:emoji_51:1430733243140931645> sended to :** ${successCount}\n` +
                            `**<:emoji_2:1430777126570688703> failed to :** ${failCount}\n` +
                            `**<:emoji_2:1430777099744055346> in rooms :** ${skippedCount}\n` +
                            (rateLimitedCount > 0 ? `**<:emoji_53:1430733925227171980> Rate Limited :** ${rateLimitedCount}\n` : '') +
                            `\n**<:emoji_52:1430734346461122654> members :** ${memberActivities.length}\n` +
                            `**<:emoji_51:1430733172710183103> Final :** ${Math.round((successCount / Math.max(memberActivities.length - skippedCount, 1)) * 100)}%`;

                        try {
                            await interaction.followUp({
                                content: finalMessage,
                                ephemeral: true
                            });
                        } catch (error) {
                            console.error('خطأ في إرسال الرسالة النهائية:', error);
                        }

                        console.log('✅ تم الانتهاء من إرسال التنبيهات بنجاح');
                    } catch (notifyError) {
                        console.error('❌ خطأ في معالج التنبيه:', notifyError);
                        try {
                            await interaction.followUp({
                                content: `**❌ حدث خطأ أثناء إرسال التنبيهات**\n\n**السبب:** ${notifyError.message || 'خطأ غير معروف'}`,
                                ephemeral: true
                            });
                        } catch (editError) {
                            console.error('خطأ في إرسال رسالة الخطأ:', editError);
                        }
                    } finally {
                        isNotifyInProgress = false;
                        console.log('🔓 تم إعادة تعيين isNotifyInProgress = false');
                    }
                }
            } catch (error) {
                console.error('خطأ في معالج الأزرار:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: '**حدث خطأ أثناء معالجة الطلب**', ephemeral: true });
                }
            }
        });

        collector.on('end', () => {
            sentMessage.edit({ components: [] }).catch(console.error);
        });

    } catch (error) {
        console.error('خطأ في عرض نشاط الرول:', error);
        await message.channel.send({ content: '**حدث خطأ أثناء جلب البيانات**' });
    }
}

module.exports = {
    name,
    execute
};
