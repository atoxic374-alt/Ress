const fs = require('fs');
const path = require('path');
const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { getAllBackups } = require('./backup.js');
const { enableProtection } = require('../utils/protectionManager.js');

const backupsDir = path.join(__dirname, '..', 'backups');

function readJSON(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return fallback;
  }
}

async function execute(message, args, { BOT_OWNERS }) {
  const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
  if (!isOwner) {
    return message.channel.send({
      embeds: [colorManager.createEmbed().setDescription('❌ **لا تملك صلاحية.**')]
    });
  }

  const backups = getAllBackups().filter(backup => backup.guildId === message.guild.id);
  if (!backups.length) {
    return message.channel.send({
      embeds: [colorManager.createEmbed().setDescription('❌ **لا توجد نسخ احتياطية لهذا السيرفر.**')]
    });
  }

  const options = backups.slice(0, 25).map(backup => ({
    label: backup.name,
    description: `${backup.guildName || 'سيرفر'} | ${new Date(backup.createdAt).toLocaleString('en-US')}`,
    value: backup.fileName
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`protect_select_${message.author.id}`)
    .setPlaceholder('اختر النسخة للحماية...')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  const embed = colorManager.createEmbed()
    .setTitle('نظام حماية الباكب')
    .setDescription('اختر النسخة التي تريد الاعتماد عليها للحماية السريعة.');

  const sent = await message.channel.send({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(menu)]
  });

  const collector = sent.createMessageComponentCollector({
    filter: i => i.user.id === message.author.id,
    time: 60000
  });

  collector.on('collect', async interaction => {
    if (!interaction.isStringSelectMenu()) return;
    const selectedFile = interaction.values[0];
    const backupData = readJSON(path.join(backupsDir, selectedFile), null);
    if (!backupData) {
      await interaction.update({
        embeds: [colorManager.createEmbed().setDescription('❌ **تعذر قراءة النسخة المختارة.**')],
        components: []
      }).catch(() => {});
      return;
    }

    enableProtection(message.guild.id, selectedFile, message.author.id);

    const successEmbed = colorManager.createEmbed()
      .setTitle('✅ تم تفعيل الحماية')
      .setDescription(`**تم اختيار النسخة بنجاح:** ${backupData.name || selectedFile}`);

    await interaction.update({ embeds: [successEmbed], components: [] }).catch(() => {});
    collector.stop('done');
  });

  collector.on('end', () => {
    sent.edit({ components: [] }).catch(() => {});
  });
}

module.exports = {
  name: 'حمايه',
  aliases: ['protect', 'protection'],
  execute
};
