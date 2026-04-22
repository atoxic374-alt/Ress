const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder
} = require('discord.js');
const colorManager = require('../utils/colorManager');

const downloadCache = new Map();

function parseTargetId(message, args = []) {
  const mention = message.mentions?.users?.first();
  if (mention) return mention.id;
  const raw = String(args[0] || '').trim();
  if (/^\d{15,22}$/.test(raw)) return raw;
  return message.author.id;
}

function getBannerUrl(user) {
  if (!user) return null;
  const isAnimated = String(user.banner || '').startsWith('a_');
  return user.bannerURL({
    extension: isAnimated ? 'gif' : 'png',
    size: 4096,
    forceStatic: false
  });
}

function makeToken(prefix, userId) {
  return `${prefix}_${userId}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

async function execute(message, args) {
  const targetId = parseTargetId(message, args);
  const user = await message.client.users.fetch(targetId, { force: true }).catch(() => null);
  if (!user) {
    await message.reply('**❌ لم يتم العثور على المستخدم.**');
    return;
  }

  const bannerUrl = getBannerUrl(user);
  if (!bannerUrl) {
    await message.reply('**❌ هذا المستخدم لا يملك بنر حالياً.**');
    return;
  }

  const token = makeToken('banner_dl', user.id);
  downloadCache.set(token, {
    url: bannerUrl,
    filename: `banner_${user.id}.${String(user.banner || '').startsWith('a_') ? 'gif' : 'png'}`,
    expiresAt: Date.now() + 10 * 60 * 1000
  });

  const embed = colorManager.createEmbed()
    .setTitle('Banner')
    .setDescription(`**المستخدم :** <@${user.id}>\n**ID :** ${user.id}`)
    .setImage(bannerUrl)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(token)
      .setLabel('تحميل مباشر')
      .setStyle(ButtonStyle.Success)
  );

  await message.reply({ embeds: [embed], components: [row] });
}

function registerInteractionHandler(client) {
  if (client.__bannerCommandHandlerRegistered) return;
  client.__bannerCommandHandlerRegistered = true;

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isButton()) return;
      if (!String(interaction.customId || '').startsWith('banner_dl_')) return;

      const entry = downloadCache.get(interaction.customId);
      if (!entry || Date.now() > entry.expiresAt) {
        downloadCache.delete(interaction.customId);
        await interaction.reply({ content: '**❌ انتهت صلاحية رابط التحميل.**', ephemeral: true });
        return;
      }

      const res = await fetch(entry.url).catch(() => null);
      if (!res || !res.ok) {
        await interaction.reply({ content: '**❌ تعذر تحميل البنر حالياً.**', ephemeral: true });
        return;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      const file = new AttachmentBuilder(buffer, { name: entry.filename });
      await interaction.reply({
        content: '**تم تجهيز التحميل المباشر :**',
        files: [file],
        ephemeral: true
      });
    } catch (error) {
      console.error('banner download error:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '**❌ حدث خطأ أثناء التحميل.**', ephemeral: true }).catch(() => {});
      }
    }
  });
}

module.exports = {
  name: 'banner',
  aliases: ['bn', 'بنر'],
  execute,
  registerInteractionHandler
};
