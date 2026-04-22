const { PermissionsBitField } = require('discord.js');
const colorManager = require('../utils/colorManager');

function parseNames(args = []) {
  const raw = args.join(' ').trim();
  if (!raw) return [];
  return raw.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 25);
}

module.exports = {
  name: 'addrole',
  aliases: ['انشاءرول'],

  async execute(message, args, { BOT_OWNERS = [] }) {
    const isOwner = BOT_OWNERS.includes(message.author.id);
    if (!isOwner) {
      await message.react('❌').catch(() => {});
      return;
    }

    const me = message.guild.members.me;
    if (!me?.permissions.has(PermissionsBitField.Flags.ManageRoles) || !message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      await message.reply('**❌ الأمر يحتاج صلاحية Manage Roles لك وللبوت.**');
      return;
    }

    const names = parseNames(args);
    if (names.length === 0) {
      await message.reply('**❌ اكتب أسماء الرولات مفصولة بفاصلة ,**\n**مثال :** addrole Team 1, Team 2');
      return;
    }

    const askEmbed = colorManager.createEmbed()
      .setTitle('Add Role')
      .setDescription('**منشن رول المركز الذي تريد إنشاء الرولات تحته.**\n**إذا لا تريد رول مركز اكتب :** 0')
      .setTimestamp();

    await message.reply({ embeds: [askEmbed] });

    const reply = await message.channel.awaitMessages({
      filter: (m) => m.author.id === message.author.id,
      max: 1,
      time: 60000
    }).catch(() => null);

    const answer = reply?.first();
    if (!answer) {
      await message.reply('**❌ انتهت مهلة الرد.**');
      return;
    }

    const raw = answer.content.trim();
    let anchorRole = null;

    if (raw !== '0') {
      anchorRole = answer.mentions.roles.first() || message.guild.roles.cache.get(raw.replace(/\D/g, '')) || message.guild.roles.cache.find((r) => r.name.toLowerCase() === raw.toLowerCase());
      if (!anchorRole) {
        await message.reply('**❌ الرول المحدد غير موجود.**');
        return;
      }

      if (anchorRole.position >= me.roles.highest.position) {
        await message.reply('**❌ لا يمكن الإنشاء تحت رول أعلى من البوت أو مساوي له.**');
        return;
      }

      if (anchorRole.position >= message.member.roles.highest.position && message.guild.ownerId !== message.author.id) {
        await message.reply('**❌ لا يمكنك الإنشاء تحت رول أعلى منك أو مساوي لك.**');
        return;
      }
    }

    let success = 0;
    let failed = 0;
    const createdMentions = [];

    for (const roleName of names) {
      try {
        const role = await message.guild.roles.create({
          name: roleName.slice(0, 100),
          permissions: []
        });

        if (anchorRole) {
          const desiredPosition = Math.max(1, anchorRole.position - 1);
          await role.setPosition(desiredPosition).catch(() => {});
        }

        success += 1;
        createdMentions.push(`<@&${role.id}>`);
      } catch {
        failed += 1;
      }
    }

    const resultEmbed = colorManager.createEmbed()
      .setTitle('نتيجة إنشاء الرولات')
      .setDescription(
        `**تم الطلب :** ${names.length}\n` +
        `**نجاح :** ${success}\n` +
        `**فشل :** ${failed}\n` +
        `**المركز :** ${anchorRole ? `<@&${anchorRole.id}>` : 'بدون مركز'}\n\n` +
        `**الرولات المنشأة :**\n${createdMentions.length ? createdMentions.join(' ، ') : '**لا يوجد**'}`
      )
      .setTimestamp();

    await message.reply({ embeds: [resultEmbed] });
  }
};
