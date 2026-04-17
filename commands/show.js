const colorManager = require('../utils/colorManager.js');
const { memberIsAdmin } = require('./store.js');

const name = 'show';
const aliases = ['اظهار', 'إظهار'];

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
  const alreadyShown = !overwrite || !overwrite.deny.has('ViewChannel');

  if (alreadyShown) {
    const alreadyEmbed = colorManager.createEmbed()
      .setDescription(`**⚠️ room ${targetChannel} is already visible.**`);
    await message.channel.send({ embeds: [alreadyEmbed] });
    return;
  }

  await targetChannel.permissionOverwrites.edit(everyoneRole.id, { ViewChannel: null }, { reason: `Shown by ${message.author.tag}` });

  const embed = colorManager.createEmbed()
    .setDescription(`**👀 room ${targetChannel} is now visible.**`);

  await message.channel.send({ embeds: [embed] });
}

module.exports = { name, aliases, execute };
