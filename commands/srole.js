const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, UserSelectMenuBuilder, PermissionsBitField } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { isUserBlocked } = require('./block.js');
const { addRoleEntry, findRoleByOwner, getGuildConfig, getGuildRoles, isManager, isCustomRolesChannelAllowed } = require('../utils/customRolesSystem.js');
const { resolveIconBuffer, applyRoleIcon } = require('../utils/roleIconUtils.js');

const name = 'انشاء';
const aliases = ['srole'];

const activeCreates = new Map();

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

async function safeDeferUpdate(interaction) {
  if (!interaction) return false;
  if (interaction.deferred || interaction.replied) return true;
  try {
    await interaction.deferUpdate();
    return true;
  } catch (error) {
    return false;
  }
}

async function respondEphemeral(interaction, payload) {
  if (!interaction) return;
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ ...payload, ephemeral: true }).catch(() => {});
  } else {
    await interaction.reply({ ...payload, ephemeral: true }).catch(() => {});
  }
}

async function logRoleAction(guild, guildConfig, description, fields = []) {
  if (!guildConfig?.logChannelId) return;
  const channel = await guild.channels.fetch(guildConfig.logChannelId).catch(() => null);
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setTitle('📝 Roles log')
    .setDescription(description)
.setThumbnail('https://cdn.discordapp.com/attachments/1373463003311243364/1465205359885946900/data.png?ex=69784253&is=6976f0d3&hm=e029b7dda1110a8bbe7b47adc2b238d6e19ae5d2c340abd5ca9b09df0d3efc27&')
    .setColor(colorManager.getColor ? colorManager.getColor() : '#2f3136')
    .setTimestamp();
  if (fields.length) embed.addFields(fields);
  await channel.send({ embeds: [embed] }).catch(() => {});
}

async function applyRoleCategoryPosition(role, guildConfig) {
  if (!role || !guildConfig?.roleCategoryId) return;
  const referenceRole = role.guild.roles.cache.get(guildConfig.roleCategoryId);
  if (!referenceRole) return;
  if (!referenceRole.editable) return;
  const desiredPosition = Math.max(1, referenceRole.position - 1);
  if (role.position === desiredPosition) return;
  await role.setPosition(desiredPosition).catch(() => {});
}

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

function buildStateEmbed(state) {
  const created = state.createdBy ? `<@${state.createdBy}>` : 'غير محدد';
  const description = [
    `**#name : ${state.name ? `**${state.name}**` : 'N/A'}\n`,
    `#limit : ${state.maxMembers ? `${state.maxMembers} في الرول` : 'N/A'}\n`,
    `#color : ${state.color || 'N/A'}\n`,
    `#icon : ${state.iconLabel || 'N/A'}\n**`  ].join('\n');

  const thumbnail = state.ownerAvatarUrl || state.creatorAvatarUrl || 'https://cdn.discordapp.com/attachments/1465209977378439262/1465210868395544689/add.png?ex=69784775&is=6976f5f5&hm=884c58ec4864821f1bd7370aa3e95a7436570e103dd66e7fe010cac52cb33396&';

  return new EmbedBuilder()
    .setTitle('إنشاء رول خاص')
    .setDescription(description)
    .setColor(colorManager.getColor ? colorManager.getColor() : '#2f3136')
    .setThumbnail(thumbnail)
.setFooter({ text: 'Roles sys;' });
}

function buildOwnerPromptEmbed(message) {
  const guild = message.guild;
  const guildRoles = getGuildRoles(guild.id);
  const ownersCount = new Set(guildRoles.map(entry => entry.ownerId)).size;
  const avatarUrl = message.author.displayAvatarURL({ size: 128 });
  return new EmbedBuilder()
    .setTitle('اختيار أونر الرول')
    .setDescription(
      `**السيرفر : ${guild.name}\n` +
      `عدد الاعضاء : ${guild.memberCount}\n` +
      `عدد اللي معهم رولات خاصه : ${ownersCount}**`
    )
    .setThumbnail(avatarUrl)
    .setColor(colorManager.getColor ? colorManager.getColor() : '#2f3136');
}
function buildButtons(state) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`srole_name_${state.sessionId}`).setLabel('اسم الرول').setEmoji('<:emoji_6:1465210605676793856>').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`srole_limit_${state.sessionId}`).setLabel('حد الرول').setEmoji('<:emoji_5:1465210549385298229>').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`srole_color_${state.sessionId}`).setLabel('لون الرول').setEmoji('<:emoji_4:1465210475754291284>').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`srole_icon_${state.sessionId}`).setLabel('ايكون  الرول').setEmoji('<:emoji_3:1465210427494502400>').setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`srole_finish_${state.sessionId}`).setLabel('إنهاء').setEmoji('<:emoji_1:1465210293666971833>').setStyle(ButtonStyle.Success).setDisabled(!state.name),
    new ButtonBuilder().setCustomId(`srole_cancel_${state.sessionId}`).setLabel('إلغاء').setEmoji('<:emoji_3:1465210368971374788>').setStyle(ButtonStyle.Danger)
  );

  return [row, row2];
}

async function promptForMessage(channel, userId, promptText, interaction) {
  let prompt = null;
  if (interaction) {
    const response = await interaction.followUp({ content: promptText, ephemeral: true, withResponse: true }).catch(() => null);
    prompt = response?.resource?.message || response || null;
  } else {
    prompt = await channel.send(promptText);
  }
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

async function promptForOwnerSelection(message, userId, interaction) {
  const menu = new UserSelectMenuBuilder()
    .setCustomId(`srole_owner_select_${Date.now()}`)
    .setPlaceholder('اختر أونر الرول...')
    .setMinValues(1)
    .setMaxValues(1);
  const row = new ActionRowBuilder().addComponents(menu);
  const promptEmbed = buildOwnerPromptEmbed(message);

  if (interaction) {
    let selectMessage = null;
    if (interaction.deferred || interaction.replied) {
      selectMessage = await interaction.editReply({
        content: 'اختر العضو المالك للرول :',
        embeds: [promptEmbed],
        components: [row]
      }).catch(() => null);
    } else {
      const response = await interaction.reply({
        content: 'اختر العضو المالك للرول :',
        embeds: [promptEmbed],
        components: [row],
        ephemeral: true,
        withResponse: true
      }).catch(() => null);
      selectMessage = response?.resource?.message || response || null;
    }
    if (!selectMessage) return null;
    const selection = await selectMessage.awaitMessageComponent({
      filter: component => component.user.id === userId,
      time: 60000
    }).catch(() => null);
    if (!selection) return null;
    await selection.update({ content: '✅ تم اختيار الأونر.', embeds: [], components: [] }).catch(() => {});
    return { ownerId: selection.values[0], promptMessage: selection.message };
  }

  const selectMessage = await message.channel.send({
    content: 'اختر العضو المالك للرول :',
    embeds: [promptEmbed],
    components: [row]
  });
  scheduleDelete(selectMessage);
  const selection = await selectMessage.awaitMessageComponent({
    filter: interaction => interaction.user.id === userId,
    time: 60000
  }).catch(() => null);
  if (!selection) return null;
  await selection.deferUpdate().catch(() => {});
  await selectMessage.edit({ content: '✅ تم اختيار الأونر.', embeds: [], components: [] }).catch(() => {});
  return { ownerId: selection.values[0], promptMessage: selectMessage };
}

async function respondEphemeral(interaction, payload) {
  if (!interaction) return;
  const replyPayload = { ...payload, ephemeral: true };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(replyPayload).catch(() => {});
    return;
  }
  await interaction.reply(replyPayload).catch(() => {});
}

async function startCreateFlow({ message, args, client, BOT_OWNERS, ownerIdOverride, interaction }) {
  if (isUserBlocked(message.author.id)) return;
  const guildConfig = getGuildConfig(message.guild.id);
  if (!isCustomRolesChannelAllowed(guildConfig, message.channel.id)) {
    if (interaction) {
      await respondEphemeral(interaction, { content: '**❌ لا يمكن استخدام أوامر الرولات الخاصة في هذا الشات.**' });
    } else {
      await sendTemp(message.channel, '**❌ لا يمكن استخدام أوامر الرولات الخاصة في هذا الشات**.');
    }
    return;
  }

  const mentionId = message.mentions?.users?.first()?.id || args.find(arg => /^\d{17,19}$/.test(arg));
  let ownerId = ownerIdOverride || mentionId;
  let ownerPromptMessage = null;
  if (!ownerId) {
    const ownerSelection = await promptForOwnerSelection(message, message.author.id, interaction);
    if (!ownerSelection?.ownerId) return;
    ownerId = ownerSelection.ownerId;
    ownerPromptMessage = ownerSelection.promptMessage;
  }

  const canManage = isManager(message.member, guildConfig, BOT_OWNERS);

  if (!canManage) {
    if (interaction) {
      await respondEphemeral(interaction, { content: '**❌ وشتبي انت.**' });
    } else {
      await sendTemp(message.channel, '**❌ وشتبي انت نادي مسؤول يسوي بس**');    }
    return;
  }

  const existingRole = findRoleByOwner(message.guild.id, ownerId);
  if (existingRole) {
    if (interaction) {
      await respondEphemeral(interaction, { content: '**⚠️ هذا العضو يمتلك رول خاص بالفعل.**' });
    } else {
      await sendTemp(message.channel, '**⚠️ هذا العضو يمتلك رول خاص بالفعل.**');
    }
    return;
  }

  const botMember = message.guild.members.me || await message.guild.members.fetchMe().catch(() => null);
  if (!botMember || !botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    if (interaction) {
      await respondEphemeral(interaction, { content: '**❌ البوت يحتاج صلاحية Manage Roles لإنشاء الرولات.**' });
    } else {
      await sendTemp(message.channel, '**❌ البوت يحتاج صلاحية Manage Roles لإنشاء الرولات.**');
    }
    return;
  }

  const ownerMember = message.guild.members.cache.get(ownerId)
    || await message.guild.members.fetch(ownerId).catch(() => null);
  const sessionId = `${message.author.id}_${Date.now()}`;
  const state = {
    sessionId,
    ownerId,
    ownerPromptMessage,
    createdBy: message.author.id,
    name: null,
    color: null,
    maxMembers: null,
    iconBuffer: null,
    iconLabel: null,
    clientAvatar: message.client.user.displayAvatarURL({ size: 128 }),
    ownerAvatarUrl: ownerMember?.user.displayAvatarURL({ size: 128 }) || null,
    creatorAvatarUrl: message.author.displayAvatarURL({ size: 128 })
  };

  activeCreates.set(sessionId, state);

  const embed = buildStateEmbed(state);
  const components = buildButtons(state);
  let sentMessage = null;
  if (interaction) {
    if (interaction.deferred || interaction.replied) {
      sentMessage = await interaction.editReply({ embeds: [embed], components }).catch(() => null);
    } else {
      const response = await interaction.reply({
        embeds: [embed],
        components,
        ephemeral: true,
        withResponse: true
      }).catch(() => null);
      sentMessage = response?.resource?.message || response || null;
    }
  } else {
    sentMessage = await message.channel.send({ embeds: [embed], components });
    scheduleDelete(sentMessage);
  }
  if (!sentMessage) return;

  const updateCreateMessage = async (sourceInteraction, updatedState) => {
    const payload = { embeds: [buildStateEmbed(updatedState)], components: buildButtons(updatedState) };
    if (sourceInteraction) {
      if (sourceInteraction.deferred || sourceInteraction.replied) {
        await sourceInteraction.editReply(payload).catch(() => {});
        return;
      }
      if (sourceInteraction.message?.editable) {
        await sourceInteraction.message.edit(payload).catch(() => {});
        return;
      }
    }
    await sentMessage.edit(payload).catch(() => {});
  };

  const collector = sentMessage.createMessageComponentCollector({
    filter: interaction => interaction.user.id === message.author.id,
    time: 300000
  });

  collector.on('collect', async interaction => {
    const parts = interaction.customId.split('_');
    const action = parts[1];
    const id = parts.slice(2).join('_');
    if (id !== sessionId) return;
    if (action === 'cancel') {
      activeCreates.delete(sessionId);
      await interaction.update({ content: '**❌ تم إلغاء إنشاء الرول.**', embeds: [], components: [] });
      collector.stop('cancelled');
      return;
    }

    if (action === 'name') {
      await interaction.deferUpdate();
      const response = await promptForMessage(message.channel, message.author.id, '- ** اكتب الأسم اللي تبيه .**', interaction);
      if (!response) return;
      state.name = response.content.slice(0, 100);
    }

    if (action === 'limit') {
      await interaction.deferUpdate();
      const response = await promptForMessage(message.channel, message.author.id, '- **اكتب حد الأعضاء (رقم) أو اكتب "بدون" لإزالته :**', interaction);
      if (!response) return;
      if (response.content.trim().toLowerCase() === 'بدون') {
        state.maxMembers = null;
      } else {
        const limit = parseInt(response.content.trim(), 10);
        if (!Number.isNaN(limit) && limit > 0) {
          state.maxMembers = limit;
        }
      }
    }

    if (action === 'color') {
      const colorMenu = new StringSelectMenuBuilder()
        .setCustomId(`srole_color_select_${sessionId}`)
        .setPlaceholder('اختر لوناً...')
        .addOptions([
          ...PRESET_COLORS.map(color => ({ label: color.label, value: color.value, emoji: color.emoji})),
          { label: 'لون مخصص', value: 'custom', emoji: '<:emoji_60:1442587668306329733>' }
        ]);

      await interaction.update({
        content: '**اختر لون الرول من القائمة :**',
        embeds: [buildStateEmbed(state)],
        components: [new ActionRowBuilder().addComponents(colorMenu)]
      });
      return;
    }

    if (action === 'icon') {
      await interaction.deferUpdate();
      const response = await promptForMessage(message.channel, message.author.id, '- **أرسل الإيموجي او صورة .**', interaction);
      if (!response) return;
      try {
        const buffer = await resolveIconBuffer(response.content, [...response.attachments.values()]);
        if (!buffer) {
          await respondEphemeral(interaction, { content: '**❌ لم يتم العثور على صورة أو إيموجي صالح.**' });
          return;
        }
        state.iconBuffer = buffer;
        state.iconLabel = 'تم التحديد';
      } catch (error) {
        await respondEphemeral(interaction, { content: '**❌ فشل تحميل الايكون، تأكد من صحة الرابط أو الإيموجي.**' });
      }
    }

    if (action === 'finish') {
      await interaction.deferUpdate();
      if (!state.name) return;

      try {
        const role = await message.guild.roles.create({
          name: state.name,
          color: state.color || undefined,
          permissions: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
          reason: `إنشاء رول خاص بواسطة ${message.author.tag}`
        });

        let finalRole = role;
        if (state.iconBuffer) {
          finalRole = await applyRoleIcon(role, state.iconBuffer);
        }
        await applyRoleCategoryPosition(finalRole, guildConfig);

        const ownerMember = await message.guild.members.fetch(state.ownerId).catch(() => null);
        if (ownerMember) {
          await ownerMember.roles.add(role, 'منح رول خاص جديد').catch(() => {});
        }

        addRoleEntry(finalRole.id, {
          roleId: finalRole.id,
          guildId: message.guild.id,
          ownerId: state.ownerId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          createdBy: state.createdBy,
          name: finalRole.name,
          color: finalRole.hexColor,
          icon: finalRole.iconURL(),
          maxMembers: state.maxMembers,
          memberMeta: {
            [state.ownerId]: {
              assignedAt: Date.now(),
              assignedBy: state.createdBy,
              assignedByIsBot: message.author.bot
            }
          }
        });

        await logRoleAction(message.guild, guildConfig, 'تم إنشاء رول خاص جديد.', [
          { name: 'الرول', value: `<@&${role.id}>`, inline: true },
          { name: 'المالك', value: `<@${state.ownerId}>`, inline: true },
          { name: 'بواسطة', value: `<@${state.createdBy}>`, inline: true }
        ]);

        const details = new EmbedBuilder()
          .setTitle('✅ تم إنشاء الرول الخاص')
          .setDescription(`الرول : <@&${role.id}>\nالأونر : <@${state.ownerId}>`)
          .setColor(colorManager.getColor ? colorManager.getColor() : '#2f3136')
          .setThumbnail(message.client.user.displayAvatarURL({ size: 128 }));

        await sendTemp(message.channel, { embeds: [details] });

        if (ownerMember) {
          await ownerMember.send({
            embeds: [
              new EmbedBuilder()
                .setTitle('تم إنشاء رولك الخاص')
                .setDescription(`الرول : ${role.name}\nتم الإنشاء بواسطة : <@${state.createdBy}>`)
                .setColor(colorManager.getColor ? colorManager.getColor() : '#2f3136')
                .setThumbnail('https://cdn.discordapp.com/attachments/1465209977378439262/1465210868395544689/add.png?ex=69784775&is=6976f5f5&hm=884c58ec4864821f1bd7370aa3e95a7436570e103dd66e7fe010cac52cb33396&')
            ]
          }).catch(() => {});
        }

        activeCreates.delete(sessionId);
        await sentMessage.edit({ embeds: [], components: [], content: '**✅ تم إكمال إنشاء الرول.**' }).catch(() => {});
        if (state.ownerPromptMessage) {
          await state.ownerPromptMessage.delete().catch(() => {});
        }
        collector.stop('completed');
        return;
      } catch (error) {
        console.error('خطأ في إنشاء الرول الخاص:', error);
        await sendTemp(message.channel, '❌ حدث خطأ أثناء إنشاء الرول.');
      }
    }

    await updateCreateMessage(interaction, state);
  });

  collector.on('end', async (_collected, reason) => {
    activeCreates.delete(sessionId);
    if (reason === 'completed' || reason === 'cancelled') return;
    if (!sentMessage.editable) return;
    await sentMessage.edit({ components: [], content: '**⏱️ انتهت مهلة الإنشاء.**' }).catch(() => {});
  });

  const interactionHandler = async interaction => {
    if (!interaction.isStringSelectMenu()) return;
    if (interaction.user.id !== message.author.id) return;

    if (interaction.customId === `srole_color_select_${sessionId}`) {
      const selected = interaction.values[0];
      if (selected === 'custom') {
        const deferred = await safeDeferUpdate(interaction);
        if (!deferred) return;
        const response = await promptForMessage(message.channel, message.author.id, '**اكتب كود اللون (Hex) مثل #ff0000:**', interaction);
        if (response && /^#?[0-9A-Fa-f]{6}$/.test(response.content.trim())) {
          const value = response.content.trim().startsWith('#') ? response.content.trim() : `#${response.content.trim()}`;
          state.color = value;
        }
      } else {
        const deferred = await safeDeferUpdate(interaction);
        if (!deferred) return;
        state.color = selected;
      }

      await interaction.editReply({ embeds: [buildStateEmbed(state)], components: buildButtons(state) }).catch(() => {});
    }
  };

  client.on('interactionCreate', interactionHandler);

  collector.on('end', () => {
    client.removeListener('interactionCreate', interactionHandler);
  });
}

async function execute(message, args, { client, BOT_OWNERS }) {
  await startCreateFlow({ message, args, client, BOT_OWNERS });
}

module.exports = { name, aliases, execute, startCreateFlow };
