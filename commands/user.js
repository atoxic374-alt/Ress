const { EmbedBuilder } = require('discord.js');
const moment = require('moment-timezone');
const colorManager = require('../utils/colorManager.js');
const { isUserBlocked } = require('./block.js');
const { isChannelBlocked } = require('./chatblock.js');

module.exports = {
    name: 'user',
    aliases: ['u'],
    description: 'يظهر معلومات تفصيلية عن العضو مع تنبيه للأعضاء الجدد',
    async execute(message, args, { client }) {
        try {
            if (isChannelBlocked(message.channel.id)) return;
            if (isUserBlocked(message.author.id)) return;

            const targetUser = message.mentions.users.first() || 
                             (args[0] ? await client.users.fetch(args[0]).catch(() => null) : message.author);

            if (!targetUser) {
                return message.reply({ embeds: [colorManager.createEmbed().setDescription('**❌ لم يتم العثور على هذا العضو**')] });
            }

            const member = message.guild.members.cache.get(targetUser.id) || 
                          await message.guild.members.fetch(targetUser.id).catch(() => null);
            
            const joinDate = member ? moment(member.joinedAt).fromNow() : 'غير موجود في السيرفر';
            const accountAge = moment(targetUser.createdAt).fromNow();

            // فحص إذا كان العضو جديداً (انضم خلال آخر 24 ساعة)
            let isNewMember = '';
            if (member) {
                const joinedTimestamp = member.joinedTimestamp;
                const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
                if (joinedTimestamp > twentyFourHoursAgo) {
                    isNewMember = '\n\n**الحالة :**\n\n**عضو جديد ✨**';
                }
            }

            let inviterInfo = 'غير معروف';
            let inviteCount = 0;
            let dbInvites = { total_invites: 0 };

            try {
                const { dbManager } = require('../utils/database.js');
                const inviterData = await dbManager.getInviter(targetUser.id);
                if (inviterData && inviterData.inviter_id) {
                    inviterInfo = `<@${inviterData.inviter_id}>`;
                } else if (member) {
                    // إذا لم يوجد داعي مسجل (للأعضاء القدامى)، ننسبهم لمالك السيرفر
                    inviterInfo = `<@${message.guild.ownerId}>`;
                }

                dbInvites = await dbManager.getInviteStats(targetUser.id);
                inviteCount = dbInvites.total_invites;
            } catch (dbError) {
                console.error('Error fetching invite stats from DB:', dbError);
                if (member) inviterInfo = `<@${message.guild.ownerId}>`;
            }

            // Fallback to live fetch if DB is 0 or error
            if (inviteCount === 0) {
                try {
                    const guildInvites = await message.guild.invites.fetch();
                    const userInvites = guildInvites.filter(i => i.inviter && i.inviter.id === targetUser.id);
                    userInvites.forEach(i => inviteCount += i.uses);
                } catch (e) {
                    // keep 0
                }
            }

            let devices = 'Offline';
            if (member && member.presence && member.presence.clientStatus) {
                const clientStatus = member.presence.clientStatus;
                const deviceMap = { desktop: 'Desktop', mobile: 'Mobile', web: 'Web' };
                const activeDevices = Object.keys(clientStatus).map(key => deviceMap[key]).filter(Boolean);
                devices = activeDevices.length > 0 ? activeDevices.join(', ') : 'Offline';
            } else if (member && member.voice && member.voice.channel) {
                devices = 'Voice (Mobile/PC)';
            } else {
                devices = 'Offline';
            }

            const embed = colorManager.createEmbed()
                .setAuthor({ 
                    name: targetUser.username, 
                    iconURL: targetUser.displayAvatarURL({ dynamic: true }) 
                })
                .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 128 }))
                .setDescription(
                    `**تاريخ دخول السيرفر :**\n` +
                    `**${joinDate}**\n\n` +
                    `**تاريخ انشاء الحساب :**\n` +
                    `**${accountAge}**\n\n` +
                    `**تم دعوة بواسطة :**\n` +
                    `${inviterInfo}\n\n` +
                    `**الدعوات :**\n` +
                    `**${inviteCount.toLocaleString()}**\n\n` +
                    `**الاجهزه :**\n` +
                    `**${devices}**` +
                    isNewMember
                );

            await message.reply({ embeds: [embed] });

        } catch (error) {
            console.error('Error in user command:', error);
            message.reply('**حدث خطأ أثناء محاولة جلب معلومات العضو.**');
        }
    }
};
