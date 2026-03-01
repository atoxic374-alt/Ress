const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, UserSelectMenuBuilder, PermissionsBitField } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { isUserBlocked } = require('./block.js');
const { findRoleByOwner, addRoleEntry, deleteRoleEntry, getGuildConfig, updateGuildConfig } = require('../utils/customRolesSystem.js');
const { resolveIconBuffer, applyRoleIcon } = require('../utils/roleIconUtils.js');
const moment = require('moment-timezone');

const name = 'رولي';
const aliases = ['myrole'];

const PRESET_COLORS = [
  { label: 'أحمر', value: '#e74c3c', emoji: '<:emoji_51:1442585157516398722>'},
  { label: 'أزرق', value: '#3498db', emoji: '<:emoji_51:1442585157516398722>' },
  { label: 'أخضر', value: '#2ecc71', emoji: '<:emoji_51:1442585157516398722>'},
  { label: 'بنفسجي', value: '#9b59b6', emoji: '<:emoji_51:1442585157516398722>' },
  { label: 'ذهبي', value: '#f1c40f', emoji: '<:emoji_51:1442585157516398722>'},
  { label: 'وردي', value: '#ff5fa2', emoji: '<:emoji_51:1442585157516398722>'},
  { label: 'أسود', value: '#2c3e50', emoji: '<:emoji_51:1442585157516398722>' },
  { label: 'رمادي', value: '#95a5a6', emoji:  '<:emoji_51:1442585157516398722>'},
  { label: 'ابيض', value: '#ffffff', emoji: '<:emoji_51:1442585157516398722>' }
];

const activeRolePanels = new Map();

function formatDurationShort(ms) {
  if (!ms || ms <= 0) return '0m';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) {
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function ensureMemberMeta(roleEntry) {
  if (!roleEntry.memberMeta) roleEntry.memberMeta = {};
  return roleEntry.memberMeta;
}

function setMemberAssignment(roleEntry, memberId, assignedById, assignedByIsBot) {
  const meta = ensureMemberMeta(roleEntry);
  meta[memberId] = {
    assignedAt: Date.now(),
    assignedBy: assignedById,
    assignedByIsBot: Boolean(assignedByIsBot)
  };
}

function removeMemberAssignment(roleEntry, memberId) {
  const meta = ensureMemberMeta(roleEntry);
  delete meta[memberId];
}

async function promptForMessage(channel, userId, promptText, interaction) {
  const prompt = interaction
    ? await respondEphemeralWithMessage(interaction, { content: promptText })
    : await channel.send(promptText);
  const collected = await channel.awaitMessages({
    filter: msg => msg.author.id === userId,
    max: 1,
    time: 60000
  });

  const response = collected.first();
  if (prompt && !interaction) scheduleDelete(prompt, 1000);
  if (response) scheduleDelete(response, 1000);

  return response;
}

async function respondEphemeral(interaction, payload) {
  if (!interaction) return;
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ ...payload, ephemeral: true }).catch(() => {});
  } else {
    await interaction.reply({ ...payload, ephemeral: true }).catch(() => {});
  }
}

function isInteractionRepliable(interaction) {
  if (!interaction) return false;
  if (typeof interaction.isRepliable === 'function') {
    return interaction.isRepliable();
  }
  return true;
}

async function safeReply(interaction, payload) {
  if (!isInteractionRepliable(interaction)) return false;
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ ...payload, ephemeral: true }).catch(() => {});
    return true;
  }
  await interaction.reply({ ...payload, ephemeral: true }).catch(() => {});
  return true;
}

async function safeDeferReply(interaction) {
  if (!isInteractionRepliable(interaction)) return false;
  if (interaction.deferred || interaction.replied) return true;
  try {
    await interaction.deferReply({ ephemeral: true });
    return true;
  } catch (error) {
    return false;
  }
}

async function respondEphemeralWithMessage(interaction, payload) {
  if (!interaction) return null;
  if (interaction.deferred || interaction.replied) {
    return interaction.followUp({ ...payload, ephemeral: true, fetchReply: true }).catch(() => null);
  }
  return interaction.reply({ ...payload, ephemeral: true, fetchReply: true }).catch(() => null);
}

function scheduleDelete(message, delay = 180000) {
  if (!message) return;
  setTimeout(() => {
    message.delete().catch(() => {});
  }, delay);
}

async function sendTemp(channel, payload, delay = 5000) {
  if (!channel) return null;
  const message = typeof payload === 'string'
    ? await channel.send(payload)
    : await channel.send(payload);
  scheduleDelete(message, delay);
  return message;
}

async function logRoleAction(guild, description, fields = []) {
  const guildConfig = getGuildConfig(guild.id);
  if (!guildConfig?.logChannelId) return;
  const channel = await guild.channels.fetch(guildConfig.logChannelId).catch(() => null);
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setTitle('📝 سجل الرولات الخاصة')
    .setDescription(description)
    .setColor(colorManager.getColor ? colorManager.getColor() : '#2f3136')
    .setTimestamp();
  if (fields.length) embed.addFields(fields);
  await channel.send({ embeds: [embed] }).catch(() => {});
}

function buildControlEmbed(roleEntry, role, membersCount) {
  const createdAt = moment(roleEntry.createdAt).tz('Asia/Riyadh').format('YYYY-MM-DD HH:mm');
  const description = [
    `**#Role : <@&${roleEntry.roleId}>`,
    `#Members : ${membersCount}`,
    `#Limit : ${roleEntry.maxMembers ? `${roleEntry.maxMembers} في الرول` : 'N/A'}**`,
  ].join('\n');

  return new EmbedBuilder()
    .setTitle('التحكم بالرول الخاص')
    .setDescription(description)
    .setColor(colorManager.getColor ? colorManager.getColor() : '#2f3136')
    .setThumbnail('https://cdn.discordapp.com/attachments/1462053630722052137/1465722134763536618/channels.png?ex=697a239c&is=6978d21c&hm=7c81be345ccae344cb53b404db8bda9c9795ed8876104716823471c63fcbbc07&')
.setFooter({ text: 'Roles sys;' });

}

function buildControlComponents(sessionId, hasIconBackup) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`myrole_action_${sessionId}`)
    .setPlaceholder('اختر إجراءً...')
    .addOptions([
      { label: 'Name', value: 'name', emoji: '<:emoji_14:1465332216375808187>', description: 'تغيير أسم الرول'},
      { label: 'Add/Remove', value: 'manage', emoji: '<:emoji_14:1465332188953186453>', description: 'أضافة/ازالة رولك من الأعضاء'},
      { label: 'Color', value: 'color', emoji: '<:emoji_10:1465332068128002291> ', description: 'تغيير لون الرول'},
      { label: 'Icon', value: 'icon', emoji: '<:emoji_13:1465332152643092733>', description: 'تغيير الايكون الخاصة بالرول'},
      { label: 'Members', value: 'members', emoji: '<:emoji_12:1465332124784656446>', description: 'رؤية اعضاء الرول'},
      { label: 'Transfer', value: 'transfer', emoji: '<:emoji_10:1465332029473161350>', description: 'نقل ملكية الرول'},
      { label: hasIconBackup ? 'Back roles' : 'Remove icons', value: 'toggle_icons', emoji: '<:emoji_22:1465338421768622313>', description: 'ازالة/ارجاع أي رول له ايكون، ليظهر رولك'}
    ]);

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`myrole_delete_${sessionId}`).setLabel('حذف الرول').setEmoji('<:emoji_21:1465336647477493894>').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`myrole_close_${sessionId}`).setLabel('إغلاق').setEmoji('<:emoji_17:1465335934580031520>').setStyle(ButtonStyle.Secondary)
  );

  return [new ActionRowBuilder().addComponents(menu), buttons];
}

async function refreshPanelMessage(panelMessage, roleEntry, role) {
  if (!panelMessage?.channel || !panelMessage?.id) return;
  const latestMessage = await panelMessage.channel.messages.fetch(panelMessage.id).catch(error => {
    if (error?.code === 10008) return null;
    console.error(`❌ Failed to fetch panel message ${panelMessage.id}:`, error);
    return null;
  });
  if (!latestMessage?.editable) return;
  const refreshedRole = await role.guild.roles.fetch(role.id).catch(error => {
    console.error(`❌ Failed to fetch role ${role.id} for panel refresh:`, error);
    return role;
  });
  const activeRole = refreshedRole || role;
  const refreshed = buildControlEmbed(roleEntry, activeRole, activeRole.members.size);
  await latestMessage.edit({ embeds: [refreshed], components: latestMessage.components }).catch(error => {
    if (error?.code === 10008) return;
    console.error(`❌ Failed to edit panel message ${panelMessage.id}:`, error);
  });
}

function getIconBackupState(guildConfig, ownerId) {
  const backups = guildConfig.roleIconBackups || {};
  return backups[ownerId] || null;
}

function setIconBackupState(guildConfig, ownerId, backup) {
  const backups = { ...(guildConfig.roleIconBackups || {}) };
  if (backup) {
    backups[ownerId] = backup;
  } else {
    delete backups[ownerId];
  }
  return backups;
}

async function handleToggleIconRoles({ channel, member, role, roleEntry, interaction, panelMessage }) {
  const guildConfig = getGuildConfig(role.guild.id);
  const existingBackup = getIconBackupState(guildConfig, roleEntry.ownerId);

  if (existingBackup?.roleIds?.length) {
    let restored = 0;
    for (const roleId of existingBackup.roleIds) {
      const targetRole = role.guild.roles.cache.get(roleId);
      if (!targetRole) continue;
      await member.roles.add(targetRole, 'إرجاع الرولات المحفوظة للايكون').then(() => {
        restored += 1;
      }).catch(() => {});
    }
    const updatedBackups = setIconBackupState(guildConfig, roleEntry.ownerId, null);
    updateGuildConfig(role.guild.id, { roleIconBackups: updatedBackups });
    if (interaction) {
      await respondEphemeral(interaction, { content: `**✅ تم إرجاع ${restored} رول.**` });
    } else {
      await sendTemp(channel, `**✅ تم إرجاع ${restored} رول.**`);
    }
    return;
  }

  const rolePosition = role.position;
  const rolesToRemove = member.roles.cache
    .filter(r => r.position > rolePosition && (r.icon || r.color !== 0))
    .map(r => r.id);

  if (rolesToRemove.length === 0) {
    if (interaction) {
      await respondEphemeral(interaction, { content: '**⚠️ لا توجد رولات ايكون أعلى من رولك.**' });
    } else {
      await sendTemp(channel, '**⚠️ لا توجد رولات ايكون أعلى من رولك.**');
    }
    return;
  }

  let removed = 0;
  for (const roleId of rolesToRemove) {
    const targetRole = role.guild.roles.cache.get(roleId);
    if (!targetRole) continue;
    await member.roles.remove(targetRole, 'إزالة رولات ذات ايكون أعلى من الرول الخاص').then(() => {
      removed += 1;
    }).catch(() => {});
  }

  const updatedBackups = setIconBackupState(guildConfig, roleEntry.ownerId, {
    roleIds: rolesToRemove,
    removedAt: Date.now()
  });
  updateGuildConfig(role.guild.id, { roleIconBackups: updatedBackups });
  if (interaction) {
    await respondEphemeral(interaction, { content: `**✅ تم إزالة ${removed} رول بايكون مؤقتًا.**` });
  } else {
    await sendTemp(channel, `**✅ تم إزالة ${removed} رول بايكون مؤقتًا.**`);
  }
}

function splitFieldText(text, maxLength = 1024) {
  if (!text) return [];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let sliceIndex = remaining.lastIndexOf('\n', maxLength);
    if (sliceIndex < 1) sliceIndex = maxLength;
    chunks.push(remaining.slice(0, sliceIndex));
    remaining = remaining.slice(sliceIndex).trimStart();
  }
  if (remaining.length) chunks.push(remaining);
  return chunks;
}

async function handleManageMembers({ channel, userId, role, roleEntry, interaction, panelMessage }) {
  const sessionId = Date.now();
  const perPage = 25;
  let currentPage = 0;
  let statusText = null;

  const getMembers = () => [...role.members.values()];

  const buildPayload = () => {
    const members = getMembers();
    const totalPages = Math.max(1, Math.ceil(members.length / perPage));
    if (currentPage >= totalPages) currentPage = totalPages - 1;
    const pageMembers = members.slice(currentPage * perPage, (currentPage + 1) * perPage);
    const list = pageMembers.map((member, index) => `#${index + 1 + currentPage * perPage} <@${member.id}>`).join('\n') || '**لا يوجد أعضاء حالياً.**';

    const addMenu = new UserSelectMenuBuilder()
      .setCustomId(`myrole_manage_add_${sessionId}`)
      .setPlaceholder('إضافة أعضاء...')
      .setMinValues(1)
      .setMaxValues(25);

    const removeOptions = pageMembers.map(member => ({
      label: member.displayName.slice(0, 100),
      value: member.id
    }));

    const removeMenu = new StringSelectMenuBuilder()
      .setCustomId(`myrole_manage_remove_${sessionId}`)
      .setPlaceholder('إزالة أعضاء...')
      .setMinValues(1)
      .setMaxValues(Math.min(25, removeOptions.length || 1));

    if (removeOptions.length) {
      removeMenu.addOptions(removeOptions);
    } else {
      removeMenu.addOptions([{ label: '**لا يوجد أعضاء**', value: 'none' }]).setDisabled(true);
    }

    const components = [
      new ActionRowBuilder().addComponents(addMenu),
      new ActionRowBuilder().addComponents(removeMenu)
    ];

    if (members.length > perPage) {
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`myrole_manage_prev_${sessionId}`)
          .setLabel('Prev')
.setEmoji('<:emoji_13:1429263136136888501>')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPage === 0),
        new ButtonBuilder()
          .setCustomId(`myrole_manage_next_${sessionId}`)
          .setLabel('Next')
.setEmoji('<:emoji_14:1429263186539974708>')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPage >= totalPages - 1)
      ));
    }

    const description = [
      statusText ? `**آخر عملية :** ${statusText}` : null,
      list,
      '',
      `**الأعضاء الحاليون ( Page ${currentPage + 1}/${totalPages} ) :**`
    ].filter(Boolean).join('\n');

    return {
      embeds: [
        new EmbedBuilder()
          .setTitle('Manage members')
          .setDescription(description)

          .setColor(colorManager.getColor ? colorManager.getColor() : '#2f3136')
          .setThumbnail('https://cdn.discordapp.com/attachments/1462053630722052137/1465722969228574963/system_1.png?ex=697a2463&is=6978d2e3&hm=8f6864998ef0fe3a85eed31682b56f0118f9bd617ccf9a6ae1312c2a8bd0bbf3&')
      ],
      components
    };
  };

  const infoMessage = interaction
    ? await respondEphemeralWithMessage(interaction, buildPayload())
    : await channel.send(buildPayload());
  if (!infoMessage) return;
  if (!interaction) {
    scheduleDelete(infoMessage);
  }

  const collector = infoMessage.createMessageComponentCollector({
    filter: i => i.user.id === userId,
    time: 60000
  });

  collector.on('collect', async selection => {
    const maxMembers = roleEntry.maxMembers || null;
    const added = [];
    const removed = [];

    if (selection.isButton()) {
      if (selection.customId === `myrole_manage_prev_${sessionId}`) currentPage = Math.max(0, currentPage - 1);
      if (selection.customId === `myrole_manage_next_${sessionId}`) currentPage += 1;
      await selection.update(buildPayload()).catch(() => {});
      return;
    }

    if (selection.isUserSelectMenu() && selection.customId === `myrole_manage_add_${sessionId}`) {
      await selection.deferUpdate().catch(() => {});
      for (const id of selection.values) {
        const member = await role.guild.members.fetch(id).catch(() => null);
        if (!member) continue;
        if (maxMembers && role.members.size >= maxMembers) break;
        await member.roles.add(role, 'إضافة إلى رول خاص').catch(() => {});
        setMemberAssignment(roleEntry, member.id, userId, selection.user.bot);
        added.push(member.id);
      }
    }

    if (selection.isStringSelectMenu() && selection.customId === `myrole_manage_remove_${sessionId}`) {
      await selection.deferUpdate().catch(() => {});
      if (!selection.values.includes('none')) {
        for (const id of selection.values) {
          const member = await role.guild.members.fetch(id).catch(() => null);
          if (!member) continue;
          await member.roles.remove(role, 'إزالة من رول خاص').catch(() => {});
          removeMemberAssignment(roleEntry, member.id);
          removed.push(member.id);
        }
      }
    }

    if (added.length || removed.length) {
      roleEntry.updatedAt = Date.now();
      addRoleEntry(role.id, roleEntry);
      statusText = ` Add : ${added.length} | Removed : ${removed.length}`;
      await logRoleAction(role.guild, 'تم تحديث أعضاء رول خاص.', [
        { name: 'الرول', value: `<@&${role.id}>`, inline: true },
        { name: 'الأونر', value: `<@${roleEntry.ownerId}>`, inline: true },
        { name: 'إضافة', value: `${added.length}`, inline: true },
        { name: 'إزالة', value: `${removed.length}`, inline: true }
      ]);
    }

    await selection.editReply(buildPayload()).catch(() => {});

    await refreshPanelMessage(panelMessage, roleEntry, role);
  });

  collector.on('end', async () => {
    statusText = statusText || 'انتهت المهلة.';
    await infoMessage.edit({ components: [], embeds: buildPayload().embeds }).catch(() => {});
  });
}

async function handleColorChange({ interaction, role, roleEntry, panelMessage }) {
  if (!role.editable) {
    await respondEphemeral(interaction, { content: '**❌ لا يمكن تعديل هذا الرول بسبب صلاحيات البوت.**' });
    return;
  }
  const colorMenu = new StringSelectMenuBuilder()
    .setCustomId(`myrole_color_select_${interaction.id}`)
    .setPlaceholder('اختر لوناً...')
    .addOptions([
      ...PRESET_COLORS.map(color => ({ label: color.label, value: color.value, emoji: color.emoji })),
      { label: 'لون مخصص', value: 'custom', emoji: '<:emoji_60:1442587668306329733>' }
    ]);

  const colorMessage = await respondEphemeralWithMessage(interaction, {
    content: '**اختر لون الرول :**',
    components: [new ActionRowBuilder().addComponents(colorMenu)],
  });

  const selection = await colorMessage?.awaitMessageComponent({
    filter: i => i.user.id === interaction.user.id && i.customId === `myrole_color_select_${interaction.id}`,
    time: 60000
  }).catch(() => null);

  if (!selection) return;
  if (selection.values[0] === 'custom') {
    await selection.deferUpdate();
    const response = await promptForMessage(interaction.channel, interaction.user.id, '**اكتب كود اللون مثل : #ffffff**', interaction);
    if (response && /^#?[0-9A-Fa-f]{6}$/.test(response.content.trim())) {
      const value = response.content.trim().startsWith('#') ? response.content.trim() : `#${response.content.trim()}`;
      await role.setColor(value).catch(() => {});
      roleEntry.color = value;
      roleEntry.updatedAt = Date.now();
      addRoleEntry(role.id, roleEntry);
    }
  } else {
    await selection.deferUpdate();
    await role.setColor(selection.values[0]).catch(() => {});
    roleEntry.color = selection.values[0];
    roleEntry.updatedAt = Date.now();
    addRoleEntry(role.id, roleEntry);
  }

  await refreshPanelMessage(panelMessage, roleEntry, role);
  await respondEphemeral(interaction, { content: '**✅ تم تحديث لون الرول.**' });
  await logRoleAction(role.guild, 'تم تغيير لون رول خاص.', [
    { name: 'الرول', value: `<@&${role.id}>`, inline: true },
    { name: 'المالك', value: `<@${roleEntry.ownerId}>`, inline: true },
    { name: 'اللون', value: roleEntry.color || 'غير محدد', inline: true }
  ]);
}

async function handleNameChange({ channel, userId, role, roleEntry, interaction, panelMessage }) {
  if (!role.editable) {
    await respondEphemeral(interaction, { content: '**❌ لا يمكن تعديل اسم هذا الرول بسبب صلاحيات البوت.**' });
    return;
  }

  const response = await promptForMessage(channel, userId, '**اكتب الاسم الجديد للرول :**', interaction);
  if (!response) return;
  const newName = response.content.trim().slice(0, 100);
  if (!newName) {
    await respondEphemeral(interaction, { content: '**❌ الاسم غير صالح.**' });
    return;
  }

  try {
    await role.setName(newName).catch(() => {});
    roleEntry.name = newName;
    roleEntry.updatedAt = Date.now();
    addRoleEntry(role.id, roleEntry);
    await refreshPanelMessage(panelMessage, roleEntry, role);
    await respondEphemeral(interaction, { content: '**✅ تم تحديث اسم الرول.**' });
    await logRoleAction(role.guild, 'تم تحديث اسم رول خاص.', [
      { name: 'الرول', value: `<@&${role.id}>`, inline: true },
      { name: 'المالك', value: `<@${roleEntry.ownerId}>`, inline: true },
      { name: 'الاسم الجديد', value: newName, inline: true }
    ]);
  } catch (error) {
    await respondEphemeral(interaction, { content: '**❌ فشل تحديث اسم الرول.**' });
  }
}

async function handleIconChange({ channel, userId, role, roleEntry, interaction, panelMessage }) {
  if (!role.editable) {
    if (interaction) {
      await respondEphemeral(interaction, { content: '**❌ لا يمكن تعديل ايكون هذا الرول بسبب صلاحيات البوت.**' });
    } else {
      await sendTemp(channel, '**❌ لا يمكن تعديل ايكون هذا الرول بسبب صلاحيات البوت.**');
    }
    return;
  }
  const response = await promptForMessage(channel, userId, '**أرسل إيموجي أو  رابط صورة أو أرفق صورة لتعيين ايكون الرول او حط ___0___ لازالته :**', interaction);
  if (!response) return;

  try {
    const rawInput = response.content.trim();
    if (rawInput === '0' || rawInput === '٠') {
      await role.setIcon(null).catch(() => {});
      roleEntry.icon = null;
      roleEntry.updatedAt = Date.now();
      addRoleEntry(role.id, roleEntry);
      await refreshPanelMessage(panelMessage, roleEntry, role);
      if (interaction) {
        await respondEphemeral(interaction, { content: '**✅ تم إزالة ايكون الرول.**' });
      } else {
        await sendTemp(channel, '**✅ تم إزالة ايكون الرول.**');
      }
      await logRoleAction(role.guild, 'تم إزالة ايكون رول خاص.', [
        { name: 'الرول', value: `<@&${role.id}>`, inline: true },
        { name: 'المالك', value: `<@${roleEntry.ownerId}>`, inline: true }
      ]);
      return;
    }
    const buffer = await resolveIconBuffer(response.content, [...response.attachments.values()]);
    if (!buffer) {
      if (interaction) {
        await respondEphemeral(interaction, { content: '**❌ لم أتمكن من معالجة هذه الايكون.**' });
      } else {
        await sendTemp(channel, '**❌ لم أتمكن من معالجة هذه الايكون.**');
      }
      return;
    }
    const refreshedRole = await applyRoleIcon(role, buffer);
    roleEntry.icon = refreshedRole.iconURL();
    roleEntry.updatedAt = Date.now();
    addRoleEntry(role.id, roleEntry);
    await refreshPanelMessage(panelMessage, roleEntry, role);
    if (interaction) {
      await respondEphemeral(interaction, { content: '**✅ تم تحديث ايكون الرول.**' });
    } else {
      await sendTemp(channel, '**✅ تم تحديث ايكون الرول.**');
    }
    await logRoleAction(role.guild, 'تم تحديث ايكون رول خاص.', [
      { name: 'الرول', value: `<@&${role.id}>`, inline: true },
      { name: 'المالك', value: `<@${roleEntry.ownerId}>`, inline: true }
    ]);
  } catch (error) {
    if (interaction) {
      await respondEphemeral(interaction, { content: '**❌ فشل تحديث الايكون.**' });
    } else {
      await sendTemp(channel, '**❌ فشل تحديث الايكون.**');
    }
  }
}

async function handleMembersList({ channel, role, interaction, roleEntry }) {
  const sessionId = Date.now();
  const perPage = 25;
  let currentPage = 0;
  let detailsText = null;

  const buildPayload = () => {
    const members = [...role.members.values()];
    const totalPages = Math.max(1, Math.ceil(members.length / perPage));
    if (currentPage >= totalPages) currentPage = totalPages - 1;
    const pageMembers = members.slice(currentPage * perPage, (currentPage + 1) * perPage);
    const list = pageMembers.map((member, index) => `**#${index + 1 + currentPage * perPage}** <@${member.id}>.`).join('\n') || '**لا يوجد أعضاء حالياً.**';

    const options = pageMembers.map(member => ({
      label: member.displayName.slice(0, 100),
      value: member.id
    }));

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`myrole_members_select_${sessionId}`)
      .setPlaceholder('اختر الأعضاء لعرض التفاصيل...')
      .setMinValues(1)
      .setMaxValues(Math.min(25, options.length || 1));

    if (options.length) {
      selectMenu.addOptions(options);
    } else {
      selectMenu.addOptions([{ label: '**لا يوجد أعضاء**', value: 'none' }]).setDisabled(true);
    }

    const components = [new ActionRowBuilder().addComponents(selectMenu)];
    if (members.length > perPage) {
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`myrole_members_prev_${sessionId}`)
          .setLabel('Prev')
.setEmoji('<:emoji_13:1429263136136888501>')

          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPage === 0),
        new ButtonBuilder()
          .setCustomId(`myrole_members_next_${sessionId}`)
          .setLabel('Next')
.setEmoji('<:emoji_14:1429263186539974708>')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPage >= totalPages - 1)
      ));
    }

    const embed = new EmbedBuilder()
      .setTitle('أعضاء الرول')
      .setDescription(list)
      .setFooter({ text: `Page ${currentPage + 1}/${totalPages} | إجمالي الأعضاء : ${members.length}` })
      .setColor(colorManager.getColor ? colorManager.getColor() : '#2f3136')
      .setThumbnail('https://cdn.discordapp.com/attachments/1438625858037350520/1465348763060277410/change.png?ex=6978c7e1&is=69777661&hm=f2b77d7490023dcd0022def91874754939cb29d3dc18984b774314b4f0bf5941&');

    if (detailsText) {
      const chunks = splitFieldText(detailsText);
      chunks.forEach((chunk, index) => {
        embed.addFields({
          name: index === 0 ? 'تفاصيل المحددين' : 'تكملة التفاصيل',
          value: chunk,
          inline: false
        });
      });
    }

    return { embeds: [embed], components };
  };

  const infoMessage = interaction
    ? await respondEphemeralWithMessage(interaction, buildPayload())
    : await channel.send(buildPayload());
  if (!infoMessage) return;
  if (!interaction) {
    scheduleDelete(infoMessage);
  }

  const collector = infoMessage.createMessageComponentCollector({
    filter: i => i.user.id === (interaction?.user?.id || roleEntry?.ownerId),
    time: 60000
  });

  collector.on('collect', async selection => {
    if (selection.isButton()) {
      if (selection.customId === `myrole_members_prev_${sessionId}`) currentPage = Math.max(0, currentPage - 1);
      if (selection.customId === `myrole_members_next_${sessionId}`) currentPage += 1;
      await selection.update(buildPayload()).catch(() => {});
      return;
    }

    if (selection.isStringSelectMenu() && selection.customId === `myrole_members_select_${sessionId}`) {
      await selection.deferUpdate().catch(() => {});
      if (selection.values.includes('none')) {
        await selection.editReply(buildPayload()).catch(() => {});
        return;
      }
      const now = Date.now();
      const details = [];
      for (const id of selection.values) {
        const member = await role.guild.members.fetch(id).catch(() => null);
        if (!member) continue;
        const meta = roleEntry?.memberMeta?.[member.id];
        const assignedAt = meta?.assignedAt
          ? moment(meta.assignedAt).tz('Asia/Riyadh').format('DD-MM')
          : 'غير معروف';
        const since = meta?.assignedAt ? formatDurationShort(now - meta.assignedAt) : '**غير معروف**';
        const assignedBy = meta?.assignedBy
          ? (meta.assignedByIsBot ? '**بوت**' : `<@${meta.assignedBy}>`)
          : '**غير معروف**';
        details.push(`**${member.displayName} (<@${member.id}>)\n• حصل على الرول بتاريخ : ${assignedAt}\n• منذ : ${since}\n• اللي اعطاه الرول : ${assignedBy}**`);
      }
      detailsText = details.join('\n\n') || null;
      await selection.editReply(buildPayload()).catch(() => {});
    }
  });

  collector.on('end', async () => {
    await infoMessage.edit({ components: [], embeds: buildPayload().embeds }).catch(() => {});
  });
}

async function handleTransfer({ channel, userId, role, roleEntry, interaction, panelMessage }) {
  if (!role.editable) {
    if (interaction) {
      await respondEphemeral(interaction, { content: '**❌ لا يمكن نقل الملكية بسبب صلاحيات البوت.**' });
    } else {
      await sendTemp(channel, '**❌ لا يمكن نقل الملكية بسبب صلاحيات البوت.**');
    }
    return;
  }
  const transferMenu = new UserSelectMenuBuilder()
    .setCustomId(`myrole_transfer_select_${Date.now()}`)
    .setPlaceholder('اختر الأونر الجديد...')
    .setMinValues(1)
    .setMaxValues(1);

  const transferPayload = {
    content: '**اختر المالك الجديد :**',
    components: [new ActionRowBuilder().addComponents(transferMenu)]
  };
  const transferMessage = interaction
    ? await respondEphemeralWithMessage(interaction, transferPayload)
    : await channel.send(transferPayload);
  if (!interaction) {
    scheduleDelete(transferMessage);
  }

  const selection = await transferMessage.awaitMessageComponent({
    filter: i => i.user.id === userId,
    time: 60000
  }).catch(() => null);

  if (!selection) return;
  const mentionId = selection.values[0];
  await selection.update({ content: '**تم اختيار المالك الجديد.**', components: [] }).catch(() => {});

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`myrole_transfer_confirm_${Date.now()}`).setLabel('Yes').setEmoji('<:emoji_2:1436850308780265615>').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`myrole_transfer_cancel_${Date.now()}`).setLabel('Cancel').setEmoji('<:emoji_23:1463998483488051465>').setStyle(ButtonStyle.Secondary)
  );
  const confirmPayload = { content: '**هل تريد تأكيد نقل الملكية؟**', components: [row] };
  const confirmMessage = interaction
    ? await respondEphemeralWithMessage(interaction, confirmPayload)
    : await channel.send(confirmPayload);
  if (!interaction) {
    scheduleDelete(confirmMessage);
  }

  const confirm = await confirmMessage.awaitMessageComponent({
    filter: i => i.user.id === userId,
    time: 30000
  }).catch(() => null);

  if (!confirm) return;

  if (confirm.customId.includes('cancel')) {
    await confirm.update({ content: '**تم إلغاء نقل الملكية.**', components: [] });
    return;
  }

  await confirm.deferUpdate();

  const newOwner = await role.guild.members.fetch(mentionId).catch(() => null);
  if (!newOwner) {
    if (interaction) {
      await respondEphemeral(interaction, { content: '**❌ العضو غير موجود.**' });
    } else {
      await sendTemp(channel, '**❌ العضو غير موجود.**');
    }
    return;
  }
  if (mentionId === roleEntry.ownerId) {
    if (interaction) {
      await respondEphemeral(interaction, { content: '**❌ هذا العضو هو المالك الحالي بالفعل.**' });
    } else {
      await sendTemp(channel, '**❌ هذا العضو هو المالك الحالي بالفعل.**');
    }
    return;
  }
  const existingOwnerRole = findRoleByOwner(role.guild.id, mentionId);
  if (existingOwnerRole && existingOwnerRole.roleId !== role.id) {
    if (interaction) {
      await respondEphemeral(interaction, { content: '**❌ هذا العضو يملك رول خاص بالفعل.**' });
    } else {
      await sendTemp(channel, '**❌ هذا العضو يملك رول خاص بالفعل.**');
    }
    return;
  }

  const previousOwnerId = roleEntry.ownerId;
  roleEntry.ownerId = mentionId;
  roleEntry.updatedAt = Date.now();
  setMemberAssignment(roleEntry, mentionId, userId, interaction?.user?.bot);
  addRoleEntry(role.id, roleEntry);
  await newOwner.roles.add(role, 'نقل ملكية رول خاص').catch(() => {});
  await refreshPanelMessage(panelMessage, roleEntry, role);
  if (interaction) {
    await respondEphemeral(interaction, { content: '**✅ تم نقل ملكية الرول.**' });
  } else {
    await sendTemp(channel, '**✅ تم نقل ملكية الرول.**');
  }
  await logRoleAction(role.guild, 'تم نقل ملكية رول خاص.', [
    { name: 'الرول', value: `<@&${role.id}>`, inline: true },
    { name: 'المالك الجديد', value: `<@${mentionId}>`, inline: true },
    { name: 'المالك السابق', value: `<@${previousOwnerId}>`, inline: true }
  ]);
}

async function startMyRoleFlow({ member, channel, client }) {
  if (activeRolePanels.has(member.id)) {
    const activePanel = activeRolePanels.get(member.id);
    const existingChannel = await member.guild.channels.fetch(activePanel.channelId).catch(() => null);
    const existingMessage = existingChannel
      ? await existingChannel.messages.fetch(activePanel.messageId).catch(() => null)
      : null;
    if (existingMessage) {
      await sendTemp(channel, '**⚠️ لديك مفتوح بالفعل.**');
      return;
    }
    activeRolePanels.delete(member.id);
  }
  const roleEntry = findRoleByOwner(member.guild.id, member.id);
  if (!roleEntry) {
    await sendTemp(channel, '**❌ ليس لديك رول خاص.**');
    return;
  }

  const role = member.guild.roles.cache.get(roleEntry.roleId);
  if (!role) {
    deleteRoleEntry(roleEntry.roleId, member.id);
    await sendTemp(channel, '**❌ لم يتم العثور على الرول في السيرفر وتم حذف بياناته.**');
    return;
  }

  const botMember = member.guild.members.me || await member.guild.members.fetchMe().catch(() => null);
  if (!botMember || !botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    await sendTemp(channel, '**❌ البوت يحتاج صلاحية Manage Roles لإدارة الرولات.**');
    return;
  }

  const membersCount = role.members.size;
  const embed = buildControlEmbed(roleEntry, role, membersCount);

  const sessionId = `${member.id}_${Date.now()}`;
  const hasIconBackup = Boolean(getIconBackupState(getGuildConfig(member.guild.id), member.id));
  const sentMessage = await channel.send({ embeds: [embed], components: buildControlComponents(sessionId, hasIconBackup) });
  scheduleDelete(sentMessage);
  activeRolePanels.set(member.id, { messageId: sentMessage.id, channelId: sentMessage.channel.id });
  setTimeout(() => {
    const panel = activeRolePanels.get(member.id);
    if (panel?.messageId === sentMessage.id) {
      activeRolePanels.delete(member.id);
    }
  }, 240000);

  const collector = sentMessage.createMessageComponentCollector({
    filter: interaction => interaction.user.id === member.id,
    time: 180000
  });

  collector.on('collect', async interaction => {
    const resetMenu = async () => {
      const latestConfig = getGuildConfig(member.guild.id);
      const hasBackup = Boolean(getIconBackupState(latestConfig, member.id));
      await sentMessage.edit({ components: buildControlComponents(sessionId, hasBackup) }).catch(() => {});
      await refreshPanelMessage(sentMessage, roleEntry, role);
    };
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('myrole_action_')) {
      const session = interaction.customId.split('_').slice(2).join('_');
      if (session !== sessionId) return;
      const action = interaction.values[0];

      if (action === 'name') {
        await interaction.deferUpdate();
        await handleNameChange({ channel, userId: member.id, role, roleEntry, interaction, panelMessage: sentMessage });
        await resetMenu();
        return;
      }

      if (action === 'color') {
        await handleColorChange({ interaction, role, roleEntry, panelMessage: sentMessage });
        await resetMenu();
        return;
      }

      if (action === 'icon') {
        await interaction.deferUpdate();
        await handleIconChange({ channel, userId: member.id, role, roleEntry, interaction, panelMessage: sentMessage });
        await resetMenu();
        return;
      }

      if (action === 'manage') {
        await interaction.deferUpdate();
        if (!role.editable) {
          await respondEphemeral(interaction, { content: '**❌ لا يمكن تعديل الأعضاء بسبب صلاحيات البوت.**' });
          await resetMenu();
          return;
        }
        await handleManageMembers({ channel, userId: member.id, role, roleEntry, interaction, panelMessage: sentMessage });
        await resetMenu();
        return;
      }

      if (action === 'members') {
        await interaction.deferUpdate();
        await handleMembersList({ channel, role, interaction, roleEntry });
        await resetMenu();
        return;
      }

      if (action === 'transfer') {
        await interaction.deferUpdate();
        await handleTransfer({ channel, userId: member.id, role, roleEntry, interaction, panelMessage: sentMessage });
        await resetMenu();
        return;
      }

      if (action === 'delete') {
        await interaction.deferUpdate();
        await handleDeleteRole({ channel, interaction, role, roleEntry, panelMessage: sentMessage });
        collector.stop('deleted');
        await resetMenu();
        return;
      }

      if (action === 'toggle_icons') {
        await interaction.deferUpdate();
        await handleToggleIconRoles({ channel, member, role, roleEntry, interaction, panelMessage: sentMessage });
        await resetMenu();
        return;
      }
    }

    const parts = interaction.customId.split('_');
    const action = parts[1];
    const session = parts.slice(2).join('_');
    if (session !== sessionId) return;

    if (action === 'close') {
      await interaction.update({ content: '**تم إغلاق لوحة التحكم.**', embeds: [], components: [] });
      collector.stop('closed');
      return;
    }

    if (action === 'delete') {
      await interaction.deferUpdate();
      await handleDeleteRole({ channel, interaction, role, roleEntry, panelMessage: sentMessage });
      collector.stop('deleted');
    }
  });

  collector.on('end', async (_collected, reason) => {
    activeRolePanels.delete(member.id);
    if (reason === 'closed') return;
    if (!sentMessage.editable) return;
    await sentMessage.edit({ components: [], content: '**⏱️ انتهت مهلة إدارة الرول.**' }).catch(() => {});
  });
}

async function execute(message, args, { client, BOT_OWNERS }) {
  if (isUserBlocked(message.author.id)) return;

  await startMyRoleFlow({ member: message.member, channel: message.channel, client });
}

async function handleMemberAction(interaction, action, client) {
  if (!interaction.guild) return;
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    await safeReply(interaction, { content: '**❌ العضو غير موجود.**' });
    return;
  }
  const roleEntry = findRoleByOwner(member.guild.id, member.id);
  if (!roleEntry) {
    await safeReply(interaction, { content: '**❌ ليس لديك رول خاص.**' });
    return;
  }
  const role = member.guild.roles.cache.get(roleEntry.roleId);
  if (!role) {
    await safeReply(interaction, { content: '**❌ لم يتم العثور على الرول في السيرفر.**' });
    return;
  }
  if (!isInteractionRepliable(interaction)) return;

  if (action === 'members') {
    await handleMembersList({ channel: interaction.channel, role, interaction, roleEntry });
    return;
  }
  if (action === 'name') {
    const deferred = await safeDeferReply(interaction);
    if (!deferred) return;
    await handleNameChange({ channel: interaction.channel, userId: member.id, role, roleEntry, interaction });
    return;
  }
  if (action === 'color') {
    await handleColorChange({ interaction, role, roleEntry });
    return;
  }
  if (action === 'icon') {
    const deferred = await safeDeferReply(interaction);
    if (!deferred) return;
    await handleIconChange({ channel: interaction.channel, userId: member.id, role, roleEntry, interaction });
    return;
  }
  if (action === 'transfer') {
    const deferred = await safeDeferReply(interaction);
    if (!deferred) return;
    await handleTransfer({ channel: interaction.channel, userId: member.id, role, roleEntry, interaction });
    return;
  }
  if (action === 'manage') {
    const deferred = await safeDeferReply(interaction);
    if (!deferred) return;
    await handleManageMembers({ channel: interaction.channel, userId: member.id, role, roleEntry, interaction });
    return;
  }
  if (action === 'delete') {
    const deferred = await safeDeferReply(interaction);
    if (!deferred) return;
    await handleDeleteRole({ channel: interaction.channel, interaction, role, roleEntry });
    return;
  }
  if (action === 'toggle_icons') {
    const deferred = await safeDeferReply(interaction);
    if (!deferred) return;
    await handleToggleIconRoles({ channel: interaction.channel, member, role, roleEntry, interaction });
    return;
  }

  await safeReply(interaction, { content: '❌ خيار غير معروف.' });
}

async function runRoleAction({ interaction, action, roleEntry, role, panelMessage }) {
  if (action === 'members') {
    await handleMembersList({ channel: interaction.channel, role, interaction, roleEntry });
    return;
  }
  if (action === 'name') {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }
    await handleNameChange({ channel: interaction.channel, userId: interaction.user.id, role, roleEntry, interaction, panelMessage });
    return;
  }
  if (action === 'color') {
    await handleColorChange({ interaction, role, roleEntry, panelMessage });
    return;
  }
  if (action === 'icon') {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }
    await handleIconChange({ channel: interaction.channel, userId: interaction.user.id, role, roleEntry, interaction, panelMessage });
    return;
  }
  if (action === 'transfer') {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }
    await handleTransfer({ channel: interaction.channel, userId: interaction.user.id, role, roleEntry, interaction, panelMessage });
    return;
  }
  if (action === 'manage') {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }
    await handleManageMembers({ channel: interaction.channel, userId: interaction.user.id, role, roleEntry, interaction, panelMessage });
    return;
  }
  if (action === 'delete') {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }
    await handleDeleteRole({ channel: interaction.channel, interaction, role, roleEntry, panelMessage });
    return;
  }
  if (action === 'toggle_icons') {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }
    const member = await interaction.guild.members.fetch(roleEntry.ownerId).catch(() => null);
    if (!member) {
      await respondEphemeral(interaction, { content: '**❌ العضو غير موجود.**' });
      return;
    }
    await handleToggleIconRoles({ channel: interaction.channel, member, role, roleEntry, interaction, panelMessage });
    return;
  }

  await respondEphemeral(interaction, { content: '**❌ خيار غير معروف.**' });
}

async function handleDeleteRole({ channel, interaction, role, roleEntry, panelMessage }) {
  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('myrole_delete_confirm').setEmoji('<:emoji_2:1436850308780265615>').setLabel('Yes').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('myrole_delete_cancel').setLabel('Cancel').setEmoji('<:emoji_23:1463998483488051465>').setStyle(ButtonStyle.Secondary)
  );
  const confirmMessage = await respondEphemeralWithMessage(interaction, {
    content: '**هل أنت متأكد من حذف رولك الخاص؟**',
    components: [confirmRow]
  });
  if (!confirmMessage) return;

  const confirmation = await confirmMessage.awaitMessageComponent({
    filter: i => i.user.id === interaction.user.id,
    time: 60000
  }).catch(() => null);
  if (!confirmation) return;

  if (confirmation.customId === 'myrole_delete_cancel') {
    await confirmation.update({ content: '**تم إلغاء الحذف.**', components: [] }).catch(() => {});
    return;
  }

  const targetRole = role.guild.roles.cache.get(role.id);
  if (targetRole && !targetRole.editable) {
    await confirmation.update({ content: '**❌ لا يمكن حذف الرول بسبب صلاحيات البوت.**', components: [] }).catch(() => {});
    return;
  }
  if (targetRole) {
    await targetRole.delete(`حذف رول خاص بواسطة المالك ${interaction.user.tag}`).catch(() => {});
  }
  deleteRoleEntry(role.id, interaction.user.id);
  const ownerMember = await role.guild.members.fetch(roleEntry.ownerId).catch(() => null);
  const ownerName = ownerMember?.displayName || interaction.user.displayName || interaction.user.username;
  await confirmation.update({ content: '*✅ تم حذف الرول الخاص بنجاح.*', components: [] }).catch(() => {});
  await sendTemp(channel, '**✅ تم حذف الرول الخاص.**');
  await logRoleAction(role.guild, 'تم حذف رول خاص بواسطة المالك.', [
    { name: 'الرول', value: `<@&${roleEntry.roleId}>`, inline: true },
    { name: 'المالك', value: ownerName, inline: true }
  ]);
  if (panelMessage?.editable) {
    await panelMessage.edit({ components: [], content: '**تم حذف الرول.**', embeds: [] }).catch(() => {});
  }
}

module.exports = { name, aliases, execute, startMyRoleFlow, handleMemberAction, runRoleAction };
