const colorManager = require('../utils/colorManager.js');
const { memberIsAdmin } = require('./store.js');

const name = 'close';
const aliases = ['قفل'];

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
  const alreadyClosed = overwrite ? overwrite.deny.has('SendMessages') : false;

  if (alreadyClosed) {
    const alreadyEmbed = colorManager.createEmbed()
      .setDescription(`**⚠️ room ${targetChannel} has been closed بالفعل.**`);
    await message.channel.send({ embeds: [alreadyEmbed] });
    return;
  }

  await targetChannel.permissionOverwrites.edit(everyoneRole.id, { SendMessages: false }, { reason: `Closed by ${message.author.tag}` });

  const embed = colorManager.createEmbed()
    .setDescription(`**🔒 room ${targetChannel} has been closed.**`);

  await message.channel.send({ embeds: [embed] });
}

module.exports = { name, aliases, execute };
