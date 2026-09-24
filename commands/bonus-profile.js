const { getDatabase } = require('../utils/database');
const { createBonusManager } = require('../utils/bonusManager');
const colorManager = require('../utils/colorManager');
const bonusSettingsCommand = require('./bonus');

const name = 'بونس';
const aliases = [];

function formatPoints(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function getGroupRole(guild, roleId) {
  return guild?.roles?.cache?.get(String(roleId)) || null;
}

async function execute(message) {
  if (!message.guild) {
    await message.reply('استخدم هذا الأمر داخل السيرفر.').catch(() => {});
    return;
  }

  try {
    const database = getDatabase();
    if (!database?.isInitialized || database.isDegraded) {
      await message.reply('نظام البونس غير جاهز حالياً، حاول بعد قليل.').catch(() => {});
      return;
    }

    const bonus = createBonusManager(database);
    const member = await message.guild.members.fetch(message.author.id).catch(() => message.member);
    const resolved = await bonusSettingsCommand.resolveCurrentGroupForMember(message.guild, member);
    const storedGroupId = (await bonus.getBalance(message.guild.id, message.author.id))?.group_id;
    const storedTarget = storedGroupId == null ? null : Number(storedGroupId);
    if (storedTarget !== resolved.targetGroupId) {
      await bonus.syncAssignment(message.guild.id, message.author.id, resolved.targetGroupId, null, 'bonus_profile_sync');
    }
    const balance = await bonus.getBalance(message.guild.id, message.author.id);
    const groupId = resolved.targetGroupId;
    const group = groupId == null ? null : resolved.groups.find(item => Number(item.id) === groupId);

    const embed = colorManager.createEmbed()
      .setTitle('بونس العضو')
      .setColor(colorManager.getColor())
      .setAuthor({
        name: member?.displayName || message.author.username,
        iconURL: message.author.displayAvatarURL?.({ extension: 'png', size: 128 }) || undefined
      })
      .setFooter({ text: 'نظام البونس' });

    if (!group) {
      embed.setDescription('أنت غير مسند حالياً إلى أي قروب بونس.');
      await message.reply({ embeds: [embed] });
      return;
    }

    const [groupPoints, role] = await Promise.all([
      bonus.getGroupPoints(message.guild.id, groupId),
      Promise.resolve(getGroupRole(message.guild, group.role_id))
    ]);
    const groupName = role?.name || 'قروب غير معروف';
    const groupImage = group.avatar_url || message.guild.iconURL?.({ extension: 'png', size: 256 }) || undefined;

    embed
      .setDescription(`بياناتك الحالية في قروب **${groupName}**`)
      .addFields(
        { name: 'القروب الحالي', value: `<@&${group.role_id}>`, inline: false },
        { name: 'نقاطي', value: `**${formatPoints(balance?.points)}**`, inline: true },
        { name: 'نقاط القروب الكلية', value: `**${formatPoints(groupPoints)}**`, inline: true }
      );
    if (groupImage) embed.setThumbnail(groupImage);

    await message.reply({ embeds: [embed] });
  } catch (error) {
    console.error('[bonus-profile] failed:', error);
    await message.reply('تعذر جلب بيانات البونس حالياً.').catch(() => {});
  }
}

module.exports = { name, aliases, execute, formatPoints };
