const { ChannelType } = require('discord.js');
const colorManager = require('../utils/colorManager');

function channelCounts(guild) {
  const values = [...guild.channels.cache.values()];
  const text = values.filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement).length;
  const voice = values.filter((c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice).length;
  const category = values.filter((c) => c.type === ChannelType.GuildCategory).length;
  const forum = values.filter((c) => c.type === ChannelType.GuildForum).length;
  return { text, voice, category, forum, total: values.length };
}

function formatBoost(guild) {
  return `**المستوى :** ${guild.premiumTier || 0}\n**عدد البوست :** ${guild.premiumSubscriptionCount || 0}`;
}

function formatAssets(guild) {
  const icon = guild.iconURL({ extension: 'png', size: 4096 }) || 'غير متوفر';
  const banner = guild.bannerURL({ extension: 'png', size: 4096 }) || 'غير متوفر';
  const splash = guild.splashURL({ extension: 'png', size: 4096 }) || 'غير متوفر';
  return `**Icon :** ${icon}\n**Banner :** ${banner}\n**Splash :** ${splash}`;
}

module.exports = {
  name: 'server',
  aliases: ['سيرفر', 'guild'],

  async execute(message) {
    const guild = message.guild;
    if (!guild) return;

    await guild.members.fetch().catch(() => null);
    await guild.channels.fetch().catch(() => null);

    const owner = await guild.fetchOwner().catch(() => null);
    const members = guild.members.cache;
    const bots = members.filter((m) => m.user.bot).size;
    const humans = Math.max(0, members.size - bots);
    const online = members.filter((m) => ['online', 'idle', 'dnd'].includes(m.presence?.status)).size;

    const channels = channelCounts(guild);
    const createdUnix = Math.floor(guild.createdTimestamp / 1000);
    const bannerImage = guild.bannerURL({ extension: 'png', size: 2048 });

    const embed = colorManager.createEmbed()
      .setAuthor({ name: guild.name, iconURL: guild.iconURL({ dynamic: true }) || undefined })
      .setTitle('Server Information')
      .setDescription('**تفاصيل السيرفر بالكامل بشكل منظم.**')
      .addFields(
        {
          name: 'الهوية الأساسية',
          value:
            `**الاسم :** ${guild.name}\n` +
            `**الآيدي :** ${guild.id}\n` +
            `**المالك :** ${owner ? `<@${owner.id}>` : 'غير متوفر'}\n` +
            `**تاريخ الإنشاء :** <t:${createdUnix}:F>\n` +
            `**منذ :** <t:${createdUnix}:R>`,
          inline: false
        },
        {
          name: 'الأعضاء',
          value:
            `**الإجمالي :** ${guild.memberCount}\n` +
            `**بشر :** ${humans}\n` +
            `**بوتات :** ${bots}\n` +
            `**متصلين (تقريبي) :** ${online}`,
          inline: true
        },
        {
          name: 'القنوات',
          value:
            `**الإجمالي :** ${channels.total}\n` +
            `**كتابي :** ${channels.text}\n` +
            `**صوتي :** ${channels.voice}\n` +
            `**فئات :** ${channels.category}\n` +
            `**Forum :** ${channels.forum}`,
          inline: true
        },
        {
          name: 'الإعدادات',
          value:
            `**التحقق :** ${guild.verificationLevel}\n` +
            `**فلتر المحتوى :** ${guild.explicitContentFilter}\n` +
            `**MFA :** ${guild.mfaLevel ? 'مفعل' : 'غير مفعل'}\n` +
            `**NSFW Level :** ${guild.nsfwLevel}`,
          inline: true
        },
        {
          name: 'التفاعل',
          value:
            `${formatBoost(guild)}\n` +
            `**الـ Emoji :** ${guild.emojis.cache.size}\n` +
            `**الستيكر :** ${guild.stickers.cache.size}\n` +
            `**الرولات :** ${guild.roles.cache.size}`,
          inline: true
        },
        {
          name: 'روابط الأصول',
          value: formatAssets(guild),
          inline: false
        }
      )
      .setThumbnail(guild.iconURL({ extension: 'png', size: 512 }))
      .setFooter({ text: `Server ID: ${guild.id}` })
      .setTimestamp();
    if (bannerImage) embed.setImage(bannerImage);

    await message.reply({ embeds: [embed] });
  }
};
