const { getBotConfigPath } = require('../utils/storagePaths');
const { EmbedBuilder, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const colorManager = require('../utils/colorManager.js');
const { isUserBlocked } = require('./block.js');
const { createPaginatedResponsibilityStats, handlePaginationInteraction } = require('../utils/responsibilityPagination.js');


const name = 'stats';

// دالة لقراءة ملف JSON
function readJSONFile(filePath, defaultValue = {}) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        }
        return defaultValue;
    } catch (error) {
        console.error(`خطأ في قراءة ${filePath}:`, error);
        return defaultValue;
    }
}

// مسارات ملفات البيانات
const dataDir = path.join(__dirname, '..', 'data');
const DATA_FILES = {
    points: path.join(dataDir, 'points.json'),
    responsibilities: path.join(dataDir, 'responsibilities.json'),
    logConfig: path.join(dataDir, 'logConfig.json'),
    adminRoles: path.join(dataDir, 'adminRoles.json'),
    botConfig: getBotConfigPath(),
    cooldowns: path.join(dataDir, 'cooldowns.json'),
    notifications: path.join(dataDir, 'notifications.json')
};

async function execute(message, args, { responsibilities, points, client, BOT_OWNERS, ADMIN_ROLES }) {
    // فحص البلوك أولاً
    if (isUserBlocked(message.author.id)) {
        const blockedEmbed = colorManager.createEmbed()
            .setDescription('**🚫 أنت محظور من استخدام أوامر البوت**\n**للاستفسار، تواصل مع إدارة السيرفر**')
            .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

        await message.channel.send({ embeds: [blockedEmbed] });
        return;
    }

    const member = await message.guild.members.fetch(message.author.id);
    const hasAdminRole = member.roles.cache.some(role => ADMIN_ROLES.includes(role.id));
    const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;

    if (!hasAdminRole && !isOwner) {
        await message.react('❌');
        return;
    }

    // تحميل جميع البيانات من ملفات JSON
    const allData = {
        points: readJSONFile(DATA_FILES.points, {}),
        responsibilities: readJSONFile(DATA_FILES.responsibilities, {}),
        logConfig: readJSONFile(DATA_FILES.logConfig, {}),
        adminRoles: readJSONFile(DATA_FILES.adminRoles, []),
        botConfig: readJSONFile(DATA_FILES.botConfig, {}),
        cooldowns: readJSONFile(DATA_FILES.cooldowns, {}),
        notifications: readJSONFile(DATA_FILES.notifications, {})
    };

    // إذا تم تحديد مسؤولية معينة في الأرغيومنت
    if (args.length > 0) {
        const responsibilityName = args.join(' ');
        if (allData.responsibilities[responsibilityName]) {
            await showResponsibilityDetails(message, responsibilityName, allData, client);
            return;
        }
    }

    // عرض المنيو الرئيسي
    await showMainStatsMenu(message, allData, client);
}

async function showMainStatsMenu(message, allData, client) {
    const guild = message.guild;
    const currentTime = new Date().toLocaleString('ar-SA', {
        timeZone: 'Asia/Riyadh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });

    // حساب إحصائيات شاملة من جميع ملفات JSON
    const stats = calculateCompleteStats(allData, guild);

    // ترتيب المسؤوليات حسب النشاط
    const responsibilityStats = [];
    Object.entries(allData.responsibilities).forEach(([respName, respData]) => {
        const respPoints = allData.points[respName] || {};
        const totalPoints = Object.values(respPoints).reduce((sum, userPoints) => {
            if (typeof userPoints === 'object') {
                return sum + Object.values(userPoints).reduce((a, b) => a + b, 0);
            }
            return sum + userPoints;
        }, 0);

        const membersCount = respData.responsibles ? respData.responsibles.length : 0;
        const activeMembersCount = Object.keys(respPoints).length;

        // حساب الطلبات الخاصة من notifications
        let specificRequests = 0;
        if (allData.notifications.specificRequests && allData.notifications.specificRequests[respName]) {
            specificRequests = Object.values(allData.notifications.specificRequests[respName]).reduce((sum, count) => sum + count, 0);
        }

        responsibilityStats.push({
            name: respName,
            totalPoints,
            membersCount,
            activeMembersCount,
            specificRequests,
            description: respData.description || 'لا يوجد شرح'
        });
    });

    responsibilityStats.sort((a, b) => b.totalPoints - a.totalPoints);

    // إنشاء الايمبد الرئيسي
    const embed = colorManager.createEmbed()
        .setTitle('** stats sys**')
        .setDescription('**اختر مسؤولية من القائمة لعرض إحصائياتها**')
        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400665805670191134/images__9_-removebg-preview.png?ex=688d772f&is=688c25af&hm=668a169f63f4bffb8c7f608e1219299de8e59765486fef4377f2d39b83d371bc&')
        .addFields([
            { name: '**إجمالي المسؤوليات**', value: `**${stats.totalResponsibilities}**`, inline: true },
            { name: '**إجمالي المسؤولين**', value: `**${stats.totalResponsibles}**`, inline: true },
            { name: '**مسؤوليات مفعلة**', value: `**${stats.activeResponsibilities}**`, inline: true },
            { name: '**إجمالي المهام المكتملة**', value: `**${stats.totalTasksCompleted}**`, inline: true },
            { name: '**مسؤولين نشطين**', value: `**${stats.activeResponsibles}**`, inline: true },
            { name: '**إجمالي التنبيهات المرسلة**', value: `**${stats.totalNotifications}**`, inline: true },
            { name: '**رولات الإدارة المسجلة**', value: `**${stats.adminRolesCount}**`, inline: true },
            { name: '**المستخدمين في فترة الانتظار**', value: `**${stats.usersOnCooldown}**`, inline: true },
            { name: '**أكثر مسؤولية نشاطاً**', value: responsibilityStats.length > 0 ? `**${responsibilityStats[0].name}** - ${responsibilityStats[0].totalPoints} نقطة` : '**لا يوجد**', inline: false }
        ])
        .setFooter({ text: `By Ahmed.`, iconURL: guild.iconURL({ dynamic: true }) })
        .setTimestamp();

    // إنشاء منيو الاختيار
    if (responsibilityStats.length === 0) {
        await message.channel.send({ embeds: [embed] });
        return;
    }

    const pagination = createPaginatedResponsibilityStats(responsibilityStats, 0);
    
    const sentMessage = await message.channel.send({ embeds: [embed], components: pagination.components });

    let currentPage = 0;

    // معالج التفاعلات
    const filter = i => i.user.id === message.author.id;
    const collector = message.channel.createMessageComponentCollector({ filter, time: 300000 });

    collector.on('collect', async interaction => {
        const operationId = `stats_${interaction.user.id}_${Date.now()}`;
        
        try {
            // فحص شامل للتفاعل
            const now = Date.now();
            const interactionAge = now - interaction.createdTimestamp;
            
            if (interactionAge > 14 * 60 * 1000) {
                console.log('تم تجاهل تفاعل إحصائيات منتهي الصلاحية');
                return;
            }

            if (!interaction || !interaction.isRepliable()) {
                console.log('تفاعل غير صالح في stats');
                return;
            }

            if (interaction.replied || interaction.deferred) {
                console.log('تم تجاهل تفاعل متكرر في stats');
                return;
            }
            
            const paginationAction = handlePaginationInteraction(interaction, 'stats_select_responsibility');
            if (paginationAction) {
                if (paginationAction.action === 'next') {
                    currentPage++;
                } else if (paginationAction.action === 'prev') {
                    currentPage--;
                }
                
                const newPagination = createPaginatedResponsibilityStats(responsibilityStats, currentPage);
                currentPage = newPagination.currentPage;
                
                await interaction.update({ embeds: [embed], components: newPagination.components });
                return;
            }
            
            if (interaction.customId === 'stats_select_responsibility') {
                const selectedResp = interaction.values[0];
                await showResponsibilityDetails(interaction, selectedResp, allData, client, true);
            } else if (interaction.customId.startsWith('stats_user_')) {
                const parts = interaction.customId.split('_');
                const respName = parts.slice(2, -1).join('_');
                const userId = parts[parts.length - 1];
                await showUserDetails(interaction, respName, userId, allData, client);
            } else if (interaction.customId === 'back_to_stats_menu') {
                await showMainStatsMenuForInteraction(interaction, allData, client);
            }
        } catch (error) {
            console.error('خطأ في معالج إحصائيات:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '**حدث خطأ أثناء معالجة الطلب**', ephemeral: true });
            }
        }
    });

    collector.on('end', () => {
        try {
            sentMessage.edit({ components: [] }).catch(console.error);
        } catch (error) {
            console.error('خطأ في إنهاء المجمع:', error);
        }
    });
}

function calculateCompleteStats(allData, guild) {
    const stats = {
        totalResponsibilities: Object.keys(allData.responsibilities).length,
        totalResponsibles: 0,
        activeResponsibilities: 0,
        totalTasksCompleted: 0,
        activeResponsibles: 0,
        totalNotifications: 0,
        adminRolesCount: allData.adminRoles.length || 0,
        usersOnCooldown: 0,
        logChannelsConfigured: 0
    };

    // حساب إحصائيات المسؤوليات
    Object.values(allData.responsibilities).forEach(resp => {
        if (resp.responsibles && resp.responsibles.length > 0) {
            stats.totalResponsibles += resp.responsibles.length;
            stats.activeResponsibilities++;
        }
    });

    // حساب إحصائيات النقاط
    const uniqueActiveUsers = new Set();
    Object.values(allData.points).forEach(respPoints => {
        Object.entries(respPoints).forEach(([userId, userPoints]) => {
            if (typeof userPoints === 'object') {
                const totalUserPoints = Object.values(userPoints).reduce((sum, pts) => sum + pts, 0);
                stats.totalTasksCompleted += totalUserPoints;
                if (totalUserPoints > 0) uniqueActiveUsers.add(userId);
            } else {
                stats.totalTasksCompleted += userPoints;
                if (userPoints > 0) uniqueActiveUsers.add(userId);
            }
        });
    });
    stats.activeResponsibles = uniqueActiveUsers.size;

    // حساب إحصائيات التنبيهات
    if (allData.notifications.sent) {
        Object.values(allData.notifications.sent).forEach(respNotifications => {
            if (typeof respNotifications === 'object') {
                stats.totalNotifications += Object.keys(respNotifications).length;
            }
        });
    }

    // حساب المستخدمين في فترة الانتظار
    if (allData.cooldowns) {
        const now = Date.now();
        Object.values(allData.cooldowns).forEach(userCooldowns => {
            if (typeof userCooldowns === 'object') {
                Object.values(userCooldowns).forEach(cooldownEnd => {
                    if (cooldownEnd > now) {
                        stats.usersOnCooldown++;
                    }
                });
            }
        });
    }

    // حساب قنوات السجلات المكونة
    if (allData.logConfig.settings) {
        Object.values(allData.logConfig.settings).forEach(setting => {
            if (setting.enabled && setting.channelId) {
                stats.logChannelsConfigured++;
            }
        });
    }

    return stats;
}

async function showResponsibilityDetails(messageOrInteraction, responsibilityName, allData, client, isInteraction = false) {
    // إعادة تحميل المسؤوليات من الملف للتأكد من أحدث البيانات
    const fs = require('fs');
    const path = require('path');
    let currentResponsibilities = {};
    try {
        const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
        if (fs.existsSync(responsibilitiesPath)) {
            const data = fs.readFileSync(responsibilitiesPath, 'utf8');
            currentResponsibilities = JSON.parse(data);
        } else {
            currentResponsibilities = allData.responsibilities;
        }
    } catch (error) {
        console.error('خطأ في إعادة تحميل المسؤوليات:', error);
        currentResponsibilities = allData.responsibilities;
    }

    const responsibility = currentResponsibilities[responsibilityName];
    if (!responsibility) {
        const errorMsg = '**المسؤولية غير موجودة**';
        if (isInteraction) {
            await messageOrInteraction.reply({ content: errorMsg, ephemeral: true });
        } else {
            await messageOrInteraction.channel.send({ content: errorMsg });
        }
        return;
    }

    const respPoints = allData.points[responsibilityName] || {};
    const responsibles = responsibility.responsibles || [];

    // حساب إحصائيات المسؤولية بشكل شامل
    let totalRequests = 0;
    let totalResponsibleRequests = 0;
    const userStats = [];

    // حساب النقاط لكل مسؤول في هذه المسؤولية
    Object.entries(respPoints).forEach(([userId, userPoints]) => {
        let totalUserPoints = 0;
        if (typeof userPoints === 'object') {
            totalUserPoints = Object.values(userPoints).reduce((sum, pts) => sum + pts, 0);
        } else {
            totalUserPoints = userPoints;
        }

        totalRequests += totalUserPoints;
        if (responsibles.includes(userId)) {
            totalResponsibleRequests += totalUserPoints;
        }
        userStats.push({ userId, points: totalUserPoints });
    });

    // ترتيب المسؤولين حسب النقاط
    userStats.sort((a, b) => b.points - a.points);

    // حساب ترتيب المسؤولية بين جميع المسؤوليات
    const allRespStats = [];
    Object.entries(allData.points).forEach(([respName, respPointsData]) => {
        let total = 0;
        Object.values(respPointsData).forEach(userPoints => {
            if (typeof userPoints === 'object') {
                total += Object.values(userPoints).reduce((sum, pts) => sum + pts, 0);
            } else {
                total += userPoints;
            }
        });
        allRespStats.push({ name: respName, total });
    });
    allRespStats.sort((a, b) => b.total - a.total);
    const rankAmongResponsibilities = allRespStats.findIndex(r => r.name === responsibilityName) + 1;

    // حساب الطلبات الخاصة
    let specificRequests = 0;
    if (allData.notifications.specificRequests && allData.notifications.specificRequests[responsibilityName]) {
        specificRequests = Object.values(allData.notifications.specificRequests[responsibilityName]).reduce((sum, count) => sum + count, 0);
    }

    // حساب التنبيهات المرسلة
    let notificationsSent = 0;
    if (allData.notifications.sent && allData.notifications.sent[responsibilityName]) {
        notificationsSent = Object.keys(allData.notifications.sent[responsibilityName]).length;
    }

    // إنشاء الايمبد
    const embed = colorManager.createEmbed()
        .setTitle(`** res stats : ${responsibilityName}**`)
        .setDescription(`**${responsibility.description || 'No desc'}**`)
        .setFooter({ text: 'By Ahmed.' })
        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400665805670191134/images__9_-removebg-preview.png?ex=688d772f&is=688c25af&hm=668a169f63f4bffb8c7f608e1219299de8e59765486fef4377f2d39b83d371bc&')
        .addFields([
            { name: '**إجمالي الاستلامات**', value: `**${totalRequests}**`, inline: true },
            { name: '**عدد المسؤولين**', value: `**${responsibles.length}**`, inline: true },
            { name: '**الترتيب بين المسؤوليات**', value: `**${rankAmongResponsibilities} من ${allRespStats.length}**`, inline: true },
            { name: '**طلبات المساعدة من المسؤولين**', value: `**${totalResponsibleRequests}**`, inline: true },
            { name: '**الطلبات الخاصة**', value: `**${specificRequests}**`, inline: true },
            { name: '**التنبيهات المرسلة**', value: `**${notificationsSent}**`, inline: true },
            { name: '**أكثر مسؤول نشاطاً**', value: userStats.length > 0 ? `**<@${userStats[0].userId}>** - ${userStats[0].points} نقطة` : '**لا يوجد**', inline: false }
        ]);

    // إنشاء أزرار المسؤولين
    const buttons = [];
    const backButton = new ButtonBuilder()
        .setCustomId('back_to_stats_menu')
        .setLabel('back menu')
        .setStyle(ButtonStyle.Secondary);

    if (responsibles.length > 0) {
        for (let i = 0; i < Math.min(responsibles.length, 4); i++) {
            const userId = responsibles[i];
            try {
                const member = await messageOrInteraction.guild.members.fetch(userId);
                const displayName = member.displayName || member.user.username;
                const userPoints = userStats.find(u => u.userId === userId)?.points || 0;

                buttons.push(
                    new ButtonBuilder()
                        .setCustomId(`stats_user_${responsibilityName}_${userId}`)
                        .setLabel(`${displayName} (${userPoints})`)
                        .setStyle(ButtonStyle.Primary)
                );
            } catch (error) {
                console.error(`فشل في جلب العضو ${userId}:`, error);
            }
        }
    }

    const rows = [];
    if (buttons.length > 0) {
        rows.push(new ActionRowBuilder().addComponents(...buttons));
    }
    rows.push(new ActionRowBuilder().addComponents(backButton));

    if (isInteraction) {
        await messageOrInteraction.update({ embeds: [embed], components: rows });
    } else {
        await messageOrInteraction.channel.send({ embeds: [embed], components: rows });
    }
}

async function showUserDetails(interaction, responsibilityName, userId, allData, client) {
    try {
        const member = await interaction.guild.members.fetch(userId);
        const displayName = member.displayName || member.user.username;

        const respPoints = allData.points[responsibilityName] || {};
        let userPointsInResp = 0;
        if (typeof respPoints[userId] === 'object') {
            userPointsInResp = Object.values(respPoints[userId]).reduce((sum, pts) => sum + pts, 0);
        } else {
            userPointsInResp = respPoints[userId] || 0;
        }

        // حساب الترتيب في المسؤولية
        const respUserStats = [];
        Object.entries(respPoints).forEach(([uid, pts]) => {
            let totalPts = 0;
            if (typeof pts === 'object') {
                totalPts = Object.values(pts).reduce((sum, p) => sum + p, 0);
            } else {
                totalPts = pts;
            }
            respUserStats.push({ userId: uid, points: totalPts });
        });
        respUserStats.sort((a, b) => b.points - a.points);

        const respRank = respUserStats.findIndex(u => u.userId === userId) + 1;

        // حساب الترتيب بين جميع المسؤوليات
        const allUserStats = [];
        Object.values(allData.points).forEach(respPointsData => {
            Object.entries(respPointsData).forEach(([uid, pts]) => {
                let totalPts = 0;
                if (typeof pts === 'object') {
                    totalPts = Object.values(pts).reduce((sum, p) => sum + p, 0);
                } else {
                    totalPts = pts;
                }

                const existing = allUserStats.find(u => u.userId === uid);
                if (existing) {
                    existing.totalPoints += totalPts;
                } else {
                    allUserStats.push({ userId: uid, totalPoints: totalPts });
                }
            });
        });

        allUserStats.sort((a, b) => b.totalPoints - a.totalPoints);
        const globalRank = allUserStats.findIndex(u => u.userId === userId) + 1;
        const totalGlobalPoints = allUserStats.find(u => u.userId === userId)?.totalPoints || 0;

        // حساب عدد المرات التي تم طلبه خصيصاً
        let specificRequests = 0;
        if (allData.notifications.specificRequests && allData.notifications.specificRequests[responsibilityName] && allData.notifications.specificRequests[responsibilityName][userId]) {
            specificRequests = allData.notifications.specificRequests[responsibilityName][userId];
        }

        // حساب التنبيهات المستلمة
        let notificationsReceived = 0;
        if (allData.notifications.received && allData.notifications.received[userId]) {
            notificationsReceived = allData.notifications.received[userId];
        }

        // حساب فترات الانتظار
        let cooldownsCount = 0;
        if (allData.cooldowns[responsibilityName] && allData.cooldowns[responsibilityName][userId]) {
            cooldownsCount = Object.keys(allData.cooldowns[responsibilityName][userId]).length;
        }

        const embed = colorManager.createEmbed()
            .setTitle(`** resb stats : ${displayName}**`)
            .setDescription(`**In : ${responsibilityName}**`)
            .setFooter({ text: 'By Ahmed.' })
            .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
            .addFields([
                { name: '**النقاط في هذه المسؤولية**', value: `**${userPointsInResp}**`, inline: true },
                { name: '**الترتيب في المسؤولية**', value: `**${respRank} من ${respUserStats.length}**`, inline: true },
                { name: '**النقاط في جميع المسؤوليات**', value: `**${totalGlobalPoints}**`, inline: true },
                { name: '**الترتيب بين جميع المسؤوليات**', value: `**${globalRank} من ${allUserStats.length}**`, inline: true },
                { name: '**الطلبات الخاصة**', value: `**${specificRequests}**`, inline: true },
                { name: '**التنبيهات المستلمة**', value: `**${notificationsReceived}**`, inline: true },
                { name: '**فترات الانتظار**', value: `**${cooldownsCount}**`, inline: true },
                { name: '** اي دي المسؤول**', value: `**${userId}**`, inline: true }
            ]);

        const backButton = new ButtonBuilder()
            .setCustomId(`back_to_responsibility_${responsibilityName}`)
            .setLabel('back')
            .setStyle(ButtonStyle.Secondary);

        const row = new ActionRowBuilder().addComponents(backButton);

        await interaction.update({ embeds: [embed], components: [row] });

        // إضافة معالج للعودة
        const filter = i => i.user.id === interaction.user.id && i.customId === `back_to_responsibility_${responsibilityName}`;
        const collector = interaction.channel.createMessageComponentCollector({ filter, time: 300000 });

        collector.on('collect', async backInteraction => {
            try {
                await showResponsibilityDetails(backInteraction, responsibilityName, allData, client, true);
                collector.stop();
            } catch (error) {
                console.error('خطأ في العودة للمسؤولية:', error);
                if (!backInteraction.replied && !backInteraction.deferred) {
                    await backInteraction.reply({ content: '**حدث خطأ أثناء العودة**', ephemeral: true });
                }
            }
        });

    } catch (error) {
        console.error('خطأ في عرض تفاصيل المستخدم:', error);
        await interaction.reply({ content: '**حدث خطأ في جلب بيانات المستخدم**', ephemeral: true });
    }
}

// معالج خاص للعودة من تفاصيل المستخدم
async function showMainStatsMenuForInteraction(interaction, allData, client) {
    const guild = interaction.guild;
    const currentTime = new Date().toLocaleString('ar-SA', {
        timeZone: 'Asia/Riyadh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });

    const stats = calculateCompleteStats(allData, guild);

    const responsibilityStats = [];
    Object.entries(allData.responsibilities).forEach(([respName, respData]) => {
        const respPoints = allData.points[respName] || {};
        let totalPoints = 0;
        Object.values(respPoints).forEach(userPoints => {
            if (typeof userPoints === 'object') {
                totalPoints += Object.values(userPoints).reduce((sum, pts) => sum + pts, 0);
            } else {
                totalPoints += userPoints;
            }
        });

        const membersCount = respData.responsibles ? respData.responsibles.length : 0;
        const activeMembersCount = Object.keys(respPoints).length;

        let specificRequests = 0;
        if (allData.notifications.specificRequests && allData.notifications.specificRequests[respName]) {
            specificRequests = Object.values(allData.notifications.specificRequests[respName]).reduce((sum, count) => sum + count, 0);
        }

        responsibilityStats.push({
            name: respName,
            totalPoints,
            membersCount,
            activeMembersCount,
            specificRequests,
            description: respData.description || 'لا يوجد شرح'
        });
    });

    responsibilityStats.sort((a, b) => b.totalPoints - a.totalPoints);

    const embed = colorManager.createEmbed()
        .setTitle('** stats sys**')
        .setDescription('**اختر مسؤولية من القائمة لعرض إحصائياتها **')
        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400665805670191134/images__9_-removebg-preview.png?ex=688d772f&is=688c25af&hm=668a169f63f4bffb8c7f608e1219299de8e59765486fef4377f2d39b83d371bc&')
        .addFields([
            { name: '**إجمالي المسؤوليات**', value: `**${stats.totalResponsibilities}**`, inline: true },
            { name: '**إجمالي المسؤولين**', value: `**${stats.totalResponsibles}**`, inline: true },
            { name: '**مسؤوليات مفعلة**', value: `**${stats.activeResponsibilities}**`, inline: true },
            { name: '**إجمالي المهام المكتملة**', value: `**${stats.totalTasksCompleted}**`, inline: true },
            { name: '**مسؤولين نشطين**', value: `**${stats.activeResponsibles}**`, inline: true },
            { name: '**إجمالي التنبيهات المرسلة**', value: `**${stats.totalNotifications}**`, inline: true },
            { name: '**الرولات الإدارة المسجلة**', value: `**${stats.adminRolesCount}**`, inline: true },
            { name: '**المستخدمين في فترة الانتظار**', value: `**${stats.usersOnCooldown}**`, inline: true },
            { name: '**أكثر مسؤولية نشاطاً**', value: responsibilityStats.length > 0 ? `**${responsibilityStats[0].name}** - ${responsibilityStats[0].totalPoints} نقطة` : '**لا يوجد**', inline: false }
        ])
        .setFooter({ text: `By Ahmed`, iconURL: guild.iconURL({ dynamic: true }) })
        .setTimestamp();

    if (responsibilityStats.length === 0) {
        await interaction.update({ embeds: [embed], components: [] });
        return;
    }

    const pagination = createPaginatedResponsibilityStats(responsibilityStats, 0);
    await interaction.update({ embeds: [embed], components: pagination.components });
}

module.exports = { name, execute };