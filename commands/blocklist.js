
const { EmbedBuilder } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { getBlockedUsers, isUserBlocked } = require('./block.js');

const name = 'blocklist';

async function execute(message, args, { client, BOT_OWNERS }) {
    // فحص البلوك أولاً
    if (isUserBlocked(message.author.id)) {
        const blockedEmbed = colorManager.createEmbed()
            .setDescription('**🚫 أنت محظور من استخدام أوامر البوت**\n**للاستفسار، تواصل مع إدارة السيرفر**')
            .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

        await message.channel.send({ embeds: [blockedEmbed] });
        return;
    }

    // فقط المالكين يمكنهم استخدام هذا الأمر
    const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
    if (!isOwner) {
        await message.react('❌');
        return;
    }

    const blockedUsers = getBlockedUsers();

    if (blockedUsers.length === 0) {
        const embed = colorManager.createEmbed()
            .setTitle('📋 **قائمة المحظورين**')
            .setDescription('**لا يوجد مستخدمين محظورين حالياً**')
            .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }))
            .setFooter({ text: 'By Ahmed.' })
            .setTimestamp();

        await message.channel.send({ embeds: [embed] });
        return;
    }

    let blockedList = '';
    let validCount = 0;

    for (let i = 0; i < blockedUsers.length; i++) {
        const userId = blockedUsers[i];
        try {
            const user = await client.users.fetch(userId);
            validCount++;
            blockedList += `${validCount}. **${user.username}** - <@${userId}>\n`;
        } catch (error) {
            // المستخدم غير موجود أو لا يمكن الوصول إليه
            validCount++;
            blockedList += `${validCount}. **مستخدم غير موجود** - \`${userId}\`\n`;
        }
    }

    const embed = colorManager.createEmbed()
        .setTitle('📋 **قائمة المحظورين**')
        .setDescription(`**عدد المحظورين:** \`${blockedUsers.length}\`\n\n${blockedList}`)
        .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }))
        .setFooter({ text: 'By Ahmed.' })
        .setTimestamp();

    await message.channel.send({ embeds: [embed] });
}

module.exports = { name, execute };
