const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { logEvent } = require('../utils/logs_system.js');
const colorManager = require('../utils/colorManager.js');
const fs = require('fs');
const path = require('path');

const name = 'block';

// مسار ملف البلوك
const blockFilePath = path.join(__dirname, '..', 'data', 'blocked_users.json');

// دالة لقراءة المستخدمين المحظورين
function getBlockedUsers() {
    try {
        if (fs.existsSync(blockFilePath)) {
            const data = fs.readFileSync(blockFilePath, 'utf8');
            return JSON.parse(data);
        }
        return [];
    } catch (error) {
        console.error('خطأ في قراءة ملف البلوك:', error);
        return [];
    }
}

// دالة لحفظ المستخدمين المحظورين
function saveBlockedUsers(blockedUsers) {
    try {
        const dataDir = path.dirname(blockFilePath);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        fs.writeFileSync(blockFilePath, JSON.stringify(blockedUsers, null, 2));
        return true;
    } catch (error) {
        console.error('خطأ في حفظ ملف البلوك:', error);
        return false;
    }
}

// دالة للتحقق من البلوك
function isUserBlocked(userId) {
    const blockedUsers = getBlockedUsers();
    return blockedUsers.includes(userId);
}

// دالة toggle للبلوك مع حماية المالكين
function toggleUserBlock(userId, BOT_OWNERS = []) {
    // حماية إضافية - لا يمكن حظر المالكين
    if (BOT_OWNERS.includes(userId)) {
        return { action: 'failed', success: false, reason: 'owner_protection' };
    }

    const blockedUsers = getBlockedUsers();
    const isBlocked = blockedUsers.includes(userId);

    if (isBlocked) {
        // إزالة البلوك
        const index = blockedUsers.indexOf(userId);
        blockedUsers.splice(index, 1);
        const success = saveBlockedUsers(blockedUsers);
        return { action: 'unblocked', success };
    } else {
        // إضافة البلوك
        blockedUsers.push(userId);
        const success = saveBlockedUsers(blockedUsers);
        return { action: 'blocked', success };
    }
}

async function execute(message, args, { client, BOT_OWNERS }) {
    // فقط المالكين يمكنهم استخدام هذا الأمر
    const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
    if (!isOwner) {
        await message.react('❌');
        return;
    }

    // التحقق من وجود منشن أو ID
    let userId = null;

    if (message.mentions.users.size > 0) {
        userId = message.mentions.users.first().id;
    } else if (args.length > 0) {
        const idMatch = args[0].match(/\d{17,19}/);
        if (idMatch) {
            userId = idMatch[0];
        }
    }

    if (!userId) {
        const embed = colorManager.createEmbed()
            .setDescription('**❌ يرجى منشن المستخدم أو كتابة ID صحيح**\n**الاستخدام:** `block @user` أو `block userid`')
            .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

        await message.channel.send({ embeds: [embed] });
        return;
    }

    // التحقق الشامل من أن المستخدم ليس مالك
    const isTargetOwner = BOT_OWNERS.includes(userId) || 
                         (client.application.owner && userId === client.application.owner.id) ||
                         (message.guild && userId === message.guild.ownerId);

    if (isTargetOwner) {
        const embed = colorManager.createEmbed()
            .setDescription('**❌ ممنوع حظر الأونرز (المالكين)**\n**لا يمكن حظر مالكي البوت أو مالك السيرفر**')
            .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

        await message.channel.send({ embeds: [embed] });
        return;
    }

    // فحص حالة المستخدم الحالية
    const isCurrentlyBlocked = isUserBlocked(userId);
    let targetUser;

    try {
        targetUser = await client.users.fetch(userId);
    } catch (error) {
        targetUser = null;
    }

    const displayName = targetUser ? targetUser.username : `User ${userId}`;
    const action = isCurrentlyBlocked ? 'إلغاء حظر' : 'حظر';

    // إنشاء رسالة تأكيد
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

    const confirmEmbed = colorManager.createEmbed()
        .setTitle(`**تأكيد ${action} المستخدم**`)
        .setDescription(`**هل أنت متأكد من أنك تريد ${action} هذا المستخدم؟**\n\n**المستخدم:** ${displayName}\n**الحالة الحالية:** ${isCurrentlyBlocked ? 'محظور' : 'غير محظور'}`)
        .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

    const confirmButton = new ButtonBuilder()
        .setCustomId(`block_confirm_${userId}`)
        .setLabel(`✅ تأكيد ${action}`)
        .setStyle(isCurrentlyBlocked ? ButtonStyle.Success : ButtonStyle.Danger);

    const cancelButton = new ButtonBuilder()
        .setCustomId('block_cancel')
        .setLabel('❌ إلغاء')
        .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

    const confirmMessage = await message.channel.send({ 
        embeds: [confirmEmbed], 
        components: [row] 
    });

    // إنشاء collector للأزرار
    const filter = (interaction) => {
        return interaction.user.id === message.author.id && 
               (interaction.customId.startsWith('block_confirm_') || interaction.customId === 'block_cancel');
    };

    const collector = confirmMessage.createMessageComponentCollector({ 
        filter, 
        time: 30000, 
        max: 1 
    });

    collector.on('collect', async (interaction) => {
        try {
            if (interaction.customId === 'block_cancel') {
                const cancelEmbed = colorManager.createEmbed()
                    .setDescription('**❌ تم إلغاء العملية**')
                    .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

                await interaction.update({ 
                    embeds: [cancelEmbed], 
                    components: [] 
                });
                return;
            }

            // تأكيد العملية
            const result = toggleUserBlock(userId, BOT_OWNERS);

            // التحقق من حماية المالكين
            if (result.reason === 'owner_protection') {
                const embed = colorManager.createEmbed()
                    .setDescription('**❌ ممنوع حظر الأونرز (المالكين)**')
                    .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

                await interaction.update({ embeds: [embed], components: [] });
                return;
            }

    if (result.success) {
                try {
                    const user = await client.users.fetch(userId);
                    let embed;

                    if (result.action === 'blocked') {
                        embed = colorManager.createEmbed()
                            .setDescription(`**✅ تم حظر ${user.username} من استخدام الأوامر والسيتب**`)
                            .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

                        // تسجيل الحدث
                        logEvent(client, message.guild, {
                            type: 'ADMIN_ACTIONS',
                            title: 'User Blocked',
                            description: `User has been blocked from using commands and setup menu`,
                            user: message.author,
                            fields: [
                                { name: 'Blocked User', value: `<@${userId}> (${user.username})`, inline: true }
                            ]
                        });
                    } else {
                        embed = colorManager.createEmbed()
                            .setDescription(`**✅ تم إلغاء حظر ${user.username} من استخدام الأوامر والسيتب**`)
                            .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

                        // تسجيل الحدث
                        logEvent(client, message.guild, {
                            type: 'ADMIN_ACTIONS',
                            title: 'User Unblocked',
                            description: `User has been unblocked from using commands and setup menu`,
                            user: message.author,
                            fields: [
                                { name: 'Unblocked User', value: `<@${userId}> (${user.username})`, inline: true }
                            ]
                        });
                    }

                    await interaction.update({ embeds: [embed], components: [] });

                } catch (error) {
                    let embed;

                    if (result.action === 'blocked') {
                        embed = colorManager.createEmbed()
                            .setDescription(`**✅ تم حظر المستخدم (ID: ${userId}) من استخدام الأوامر والسيتب**`)
                            .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));
                    } else {
                        embed = colorManager.createEmbed()
                            .setDescription(`**✅ تم إلغاء حظر المستخدم (ID: ${userId}) من استخدام الأوامر والسيتب**`)
                            .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));
                    }

                    await interaction.update({ embeds: [embed], components: [] });
                }
            } else {
                const embed = colorManager.createEmbed()
                    .setDescription('**❌ حدث خطأ أثناء تطبيق التغيير**')
                    .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

                await interaction.update({ embeds: [embed], components: [] });
            }

        } catch (error) {
            console.error('Error in block confirmation:', error);
        }
    });

    collector.on('end', async (collected, reason) => {
        if (reason === 'time') {
            try {
                const timeoutEmbed = colorManager.createEmbed()
                    .setDescription('**⏰ انتهت مهلة الانتظار**')
                    .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

                await sentMessage.edit({ embeds: [timeoutEmbed], components: [] });
            } catch (error) {
                console.error('خطأ في timeout:', error);
            }
        }
    });
}



// دالة لحذف جميع المحظورين
function clearAllBlocks() {
    try {
        const success = saveBlockedUsers([]);
        return { success, message: success ? 'تم حذف جميع المحظورين' : 'فشل في حذف المحظورين' };
    } catch (error) {
        console.error('خطأ في حذف المحظورين:', error);
        return { success: false, message: 'حدث خطأ أثناء حذف المحظورين' };
    }
}

// تصدير الدوال للاستخدام في ملفات أخرى
module.exports = {
    name,
    execute,
    isUserBlocked,
    getBlockedUsers,
    toggleUserBlock,
    clearAllBlocks
};