const colorManager = require('../utils/colorManager.js');
const { memberIsAdmin } = require('./store.js');

const name = 'hide';
const aliases = ['اخفاء', 'إخفاء'];

async function execute(message, args, { BOT_OWNERS = [] }) {
  if (!memberIsAdmin(message.member, BOT_OWNERS)) {
    await message.react('❌');
    return;
  }

  const targetChannel = message.mentions.channels.first() || message.channel;
  if (!targetChannel || !targetChannel.isTextBased()) {
    await message.react('❌');
    return;
  }

  const everyoneRole = message.guild.roles.everyone;
  const overwrite = targetChannel.permissionOverwrites.cache.get(everyoneRole.id);
  const alreadyHidden = overwrite ? overwrite.deny.has('ViewChannel') : false;

  if (alreadyHidden) {
    const alreadyEmbed = colorManager.createEmbed()
      .setDescription(`**⚠️ room ${targetChannel} is already hidden.**`);
    await message.channel.send({ embeds: [alreadyEmbed] });
    return;
  }

  await targetChannel.permissionOverwrites.edit(everyoneRole.id, { ViewChannel: false }, { reason: `Hidden by ${message.author.tag}` });

  const embed = colorManager.createEmbed()
    .setDescription(`**🙈 room ${targetChannel} has been hidden.**`);

  await message.channel.send({ embeds: [embed] });
}

module.exports = { name, aliases, execute };
