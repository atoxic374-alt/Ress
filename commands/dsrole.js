const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { isUserBlocked } = require('./block.js');
const { getGuildConfig, getRoleEntry, deleteRoleEntry, findRoleByOwner, isManager, getGuildRoles } = require('../utils/customRolesSystem.js');

const name = 'حذف';
const aliases = ['dsrole'];

async function execute(message, args, { client, BOT_OWNERS }) {
  if (isUserBlocked(message.author.id)) return;

  const guildConfig = getGuildConfig(message.guild.id);
  const canManage = isManager(message.member, guildConfig, BOT_OWNERS);
  if (!canManage) {
    await message.react('❌').catch(() => {});
    return;
  }

  const mentionedRoles = message.mentions.roles.map(role => role.id);
  const mentionedUsers = message.mentions.users.map(user => user.id);
  const idArgs = args.filter(arg => /^\d{17,19}$/.test(arg));
  const hasExplicitTarget = mentionedRoles.length > 0 || mentionedUsers.length > 0 || idArgs.length > 0;

  const explicitRoleIds = new Set(mentionedRoles);
  const ownerCandidates = new Set(mentionedUsers);

  for (const id of idArgs) {
    if (message.guild.roles.cache.has(id)) {
      explicitRoleIds.add(id);
    } else {
      ownerCandidates.add(id);
    }
  }

  const resolvedRoleIds = new Set();
  const roleEntries = new Map();

  for (const roleId of explicitRoleIds) {
    const entry = getRoleEntry(roleId);
    if (entry && entry.guildId === message.guild.id) {
      resolvedRoleIds.add(roleId);
      roleEntries.set(roleId, entry);
    }
  }

  for (const ownerId of ownerCandidates) {
    const entry = findRoleByOwner(message.guild.id, ownerId);
    if (entry) {
      resolvedRoleIds.add(entry.roleId);
      roleEntries.set(entry.roleId, entry);
    }
  }

  if (resolvedRoleIds.size > 0) {
    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`dsrole_confirm_${message.author.id}`).setLabel('تأكيد الحذف').setEmoji('<:emoji_7:1465221394966253768>').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`dsrole_cancel_${message.author.id}`).setLabel('إلغاء').setEmoji('<:emoji_7:1465221361839505622>').setStyle(ButtonStyle.Secondary)
    );

    const roleLines = [...resolvedRoleIds].slice(0, 20).map(roleId => {
      const role = message.guild.roles.cache.get(roleId);
      const entry = roleEntries.get(roleId);
      return `• ${role ? `<@&${roleId}>` : roleId} - <@${entry?.ownerId || 'غير معروف'}>`;
    });
    const extraCount = Math.max(0, resolvedRoleIds.size - roleLines.length);
    const extraText = extraCount > 0 ? `\n**...وعدد ${extraCount} رول أخرى.**` : '';

    const embed = new EmbedBuilder()
      .setTitle('تأكيد حذف الرولات')
      .setDescription(`**سيتم حذف ${resolvedRoleIds.size} رول:**\n${roleLines.join('\n')}${extraText}`)
      .setColor(colorManager.getColor ? colorManager.getColor() : '#2f3136')
      .setThumbnail('https://cdn.discordapp.com/attachments/1465209977378439262/1465221268692275251/delete_5.png?ex=69785124&is=6976ffa4&hm=84c2e9633637ab34f90545a3196a5243cebb0f5272247f03ff430ea0fbbf089e&');

    const sentMessage = await message.channel.send({ embeds: [embed], components: [confirmRow] });

    const collector = sentMessage.createMessageComponentCollector({
      filter: interaction => interaction.user.id === message.author.id,
      time: 60000
    });

    collector.on('collect', async interaction => {
      if (interaction.customId.startsWith('dsrole_cancel_')) {
        await interaction.update({ content: '**تم إلغاء العملية.**', embeds: [], components: [] });
        collector.stop('cancelled');
        return;
      }

      await interaction.deferUpdate();
      for (const roleId of resolvedRoleIds) {
        const targetRole = message.guild.roles.cache.get(roleId);
        if (targetRole) {
          if (!targetRole.editable) {
            continue;
          }
          await targetRole.delete(`حذف رول خاص بواسطة ${message.author.tag}`).catch(() => {});
        }
        deleteRoleEntry(roleId, message.author.id);
      }
      await sentMessage.edit({ content: '**✅ تم حذف الرولات الخاصة بنجاح.**', embeds: [], components: [] });
      collector.stop('deleted');
    });

    return;
  }

  if (hasExplicitTarget) {
    await message.reply('**❌ لا يوجد رولات خاصة مطابقة للمنشن أو الـ ID.**');
    return;
  }

  const customRoleEntries = getGuildRoles(message.guild.id);
  const customRoleOptions = customRoleEntries
    .map(entry => {
      const role = message.guild.roles.cache.get(entry.roleId);
      if (!role) return null;
      return { label: role.name || `Role ${entry.roleId}`, value: entry.roleId };
    })
    .filter(Boolean)
    .slice(0, 25);

  if (customRoleOptions.length === 0) {
    await message.reply('**❌ لا توجد رولات خاصة مسجلة للحذف.**');
    return;
  }

  const roleMenu = new StringSelectMenuBuilder()
    .setCustomId(`dsrole_bulk_${message.author.id}`)
    .setPlaceholder('ابحث عن الرولات للحذف...')
    .setMinValues(1)
    .setMaxValues(customRoleOptions.length)
    .addOptions(customRoleOptions);

  const row = new ActionRowBuilder().addComponents(roleMenu);

  const extraNotice = customRoleEntries.length > 25
    ? '\n**⚠️ القائمة تعرض أول 25 رول فقط. استخدم منشن/ID لحذف باقي الرولات.**'
    : '';
  const embed = new EmbedBuilder()
    .setTitle('Delete roles')
    .setDescription(`**ابحث واختر الرولات المراد حذفها :**${extraNotice}`)
    .setColor(colorManager.getColor ? colorManager.getColor() : '#2f3136')
    .setThumbnail('https://cdn.discordapp.com/attachments/1465209977378439262/1465221268692275251/delete_5.png?ex=69785124&is=6976ffa4&hm=84c2e9633637ab34f90545a3196a5243cebb0f5272247f03ff430ea0fbbf089e&')
    .setFooter({ text: 'Roles sys;' });

  const sentMessage = await message.channel.send({ embeds: [embed], components: [row] });

  const collector = sentMessage.createMessageComponentCollector({
    filter: interaction => interaction.user.id === message.author.id,
    time: 60000
  });

  collector.on('collect', async interaction => {
    if (!interaction.isStringSelectMenu()) return;

    const selectedRoles = interaction.values;
    const validRoleIds = selectedRoles.filter(roleId => {
      const entry = getRoleEntry(roleId);
      return entry && entry.guildId === message.guild.id;
    });

    if (validRoleIds.length === 0) {
      await interaction.update({ content: '**❌ الرولات المحددة ليست ضمن الرولات الخاصة.**', embeds: [], components: [] });
      collector.stop('no-valid');
      return;
    }

    const invalidRoleIds = selectedRoles.filter(roleId => !validRoleIds.includes(roleId));
    const warningText = invalidRoleIds.length > 0
      ? `\n**⚠️ تم تجاهل ${invalidRoleIds.length} رول لأنها ليست ضمن الرولات الخاصة.**`
      : '';

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`dsrole_bulk_confirm_${message.author.id}`).setLabel('تأكيد الحذف').setEmoji('<:emoji_7:1465221394966253768>').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`dsrole_bulk_cancel_${message.author.id}`).setLabel('إلغاء').setEmoji('<:emoji_7:1465221361839505622>').setStyle(ButtonStyle.Secondary)
    );

    await interaction.update({
      content: `**سيتم حذف ${validRoleIds.length} رول. هل أنت متأكد؟**${warningText}`,
      embeds: [],
      components: [confirmRow]
    });

    const confirmCollector = sentMessage.createMessageComponentCollector({
      filter: btn => btn.user.id === message.author.id,
      time: 30000
    });

    confirmCollector.on('collect', async btn => {
      if (btn.customId.includes('cancel')) {
        await btn.update({ content: '**تم إلغاء الحذف المتعدد.**', components: [] });
        confirmCollector.stop('cancelled');
        return;
      }

      await btn.deferUpdate();
      for (const roleId of validRoleIds) {
        const role = message.guild.roles.cache.get(roleId);
        if (role) {
          await role.delete(`حذف متعدد بواسطة ${message.author.tag}`).catch(() => {});
        }
        deleteRoleEntry(roleId, message.author.id);
      }
      await sentMessage.edit({ content: '**✅ تم حذف الرولات المحددة بنجاح.**', components: [] });
      confirmCollector.stop('done');
    });
  });
}

module.exports = { name, aliases, execute };
