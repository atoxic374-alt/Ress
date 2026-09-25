const { getDatabase } = require('../utils/database');
const { createBonusManager } = require('../utils/bonusManager');
const colorManager = require('../utils/colorManager');
const bonusSettingsCommand = require('./bonus');

const name = 'بونس';
const aliases = ['bonus-profile', 'bprofile'];

function formatPoints(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function getGroupRole(guild, roleId) {
  return guild?.roles?.cache?.get(String(roleId)) || null;
}

function extractUserId(value) {
  const raw = String(value || '').trim();
  const mention = raw.match(/^<@!?(\d{15,21})>$/);
  if (mention) return mention[1];
  return /^\d{15,21}$/.test(raw) ? raw : null;
}

async function resolveTargetMember(message, args = []) {
  const mentioned = message.mentions?.members?.first?.();
  if (mentioned) return mentioned;
  const userId = extractUserId(args[0]);
  if (!userId) return message.member || message.guild.members.fetch(message.author.id);
  return message.guild.members.fetch(userId).catch(() => null);
}

async function execute(message, args = []) {
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
    const member = await resolveTargetMember(message, args);
    if (!member) {
      await message.reply('Member not found. Use a mention or a valid user ID.').catch(() => {});
      return;
    }
    const resolved = await bonusSettingsCommand.resolveCurrentGroupForMember(message.guild, member);
    const storedGroupId = (await bonus.getBalance(message.guild.id, member.id))?.group_id;
    const storedTarget = storedGroupId == null ? null : Number(storedGroupId);
    if (storedTarget !== resolved.targetGroupId) {
      await bonus.syncAssignment(message.guild.id, member.id, resolved.targetGroupId, null, 'bonus_profile_sync');
    }
    const balance = await bonus.getBalance(message.guild.id, member.id);
    const groupId = resolved.targetGroupId;
    const group = groupId == null ? null : resolved.groups.find(item => Number(item.id) === groupId);

    const embed = colorManager.createEmbed()
      .setTitle('Bonus Profile')
      .setColor(colorManager.getColor())
      .setAuthor({
        name: `${member.displayName || member.user.username} • Bonus Profile`,
        iconURL: member.displayAvatarURL?.({ extension: 'png', size: 128 }) || undefined
      })
      .setFooter({
        text: message.guild.name,
        iconURL: message.guild.iconURL?.({ extension: 'png', size: 64 }) || undefined
      })
      .setTimestamp();

    if (!group) {
      embed.setDescription(`No active bonus group is assigned to <@${member.id}>.`)
        .addFields({ name: 'Member', value: `<@${member.id}>`, inline: true },
          { name: 'Status', value: 'Unassigned', inline: true });
      const serverIcon = message.guild.iconURL?.({ extension: 'png', size: 256 });
      if (serverIcon) embed.setThumbnail(serverIcon);
      await message.reply({ embeds: [embed] });
      return;
    }

    const [groupPoints, role] = await Promise.all([
      bonus.getGroupPoints(message.guild.id, groupId),
      Promise.resolve(getGroupRole(message.guild, group.role_id))
    ]);
    const groupName = role?.name || 'Unknown Group';
    const serverIcon = message.guild.iconURL?.({ extension: 'png', size: 256 });

    embed
      .setDescription(`Bonus statistics for <@${member.id}> in **${groupName}**`)
      .addFields(
        { name: 'Member', value: `<@${member.id}>`, inline: true },
        { name: 'Status', value: 'Active', inline: true },
        { name: 'Bonus Group', value: `<@&${group.role_id}>`, inline: false },
        { name: 'Personal Points', value: `**${formatPoints(balance?.points)}**`, inline: true },
        { name: 'Group Total', value: `**${formatPoints(groupPoints)}**`, inline: true },
        { name: 'Message Progress', value: `**${formatPoints(balance?.message_progress)}**`, inline: true },
        { name: 'Voice Progress', value: `**${formatPoints(Math.floor((Number(balance?.voice_progress_ms) || 0) / 3600000))}h**`, inline: true }
      );
    if (serverIcon) embed.setThumbnail(serverIcon);

    await message.reply({ embeds: [embed] });
  } catch (error) {
    console.error('[bonus-profile] failed:', error);
    await message.reply('تعذر جلب بيانات البونس حالياً.').catch(() => {});
  }
}

module.exports = { name, aliases, execute, formatPoints };
