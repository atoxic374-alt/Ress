const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const colorManager = require('../utils/colorManager');

module.exports = {
  name: 'link',
  aliases: ['invite', 'دعوة', 'رابط'],
  description: 'Send bot invite link in DM',
  async execute(message, args, { client }) {
    try {
      const botId = client?.user?.id;
      if (!botId) {
        await message.react('❌').catch(() => {});
        return;
      }

      const perms = new PermissionsBitField([
        PermissionFlagsBits.Administrator
      ]).bitfield.toString();
      const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${botId}&permissions=${perms}&scope=bot%20applications.commands`;

      const embed = colorManager.createEmbed()
        .setTitle('رابط إضافة البوت')
        .setDescription(`**اضغط هنا لإضافة البوت:**\n${inviteUrl}`);

      await message.author.send({ embeds: [embed] });
      await message.react('✅').catch(() => {});
    } catch {
      await message.react('❌').catch(() => {});
    }
  }
};
