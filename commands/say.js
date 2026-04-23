const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

const colorManager = require('../utils/colorManager.js');
const { memberIsAdmin } = require('./store.js');

const name = 'say';
const aliases = ['قول'];

const saySessions = new Map();

function getSession(sessionId) {
  const session = saySessions.get(sessionId);
  if (!session) return null;
  if (Date.now() - session.createdAt > 30 * 60 * 1000) {
    saySessions.delete(sessionId);
    return null;
  }
  return session;
}

function buildDetailsEmbed(session, statusText = null) {
  const channelsText = session.channelIds.length
    ? session.channelIds.map(id => `<#${id}>`).join(' ، ')
    : '**غير محدد**';
  const usersText = session.dmUserIds.length
    ? session.dmUserIds.map(id => `<@${id}>`).join(' ، ')
    : '**غير محدد**';

  const messageText = session.text ? `**${session.text}**` : '**غير محدد**';
  const typeText = session.type === 'embed' ? '**ايمبد**' : '**رسالة عادية**';
  const targetTypeText = session.dmUserIds.length > 0 ? '**خاص**' : '**رومات**';

  let embedDetailsText = '';
  if (session.type === 'embed') {
    let imageText = '**لا يوجد**';
    if (session.imageMode === 'guild_avatar') imageText = '**صورة افتار السيرفر**';
    else if (session.imageMode === 'user_avatar') imageText = '**صورة افتارك**';
    else if (session.imageMode === 'custom') imageText = session.customImageUrl ? `**مخصص :** ${session.customImageUrl}` : '**مخصص :** **غير محدد**';

    let thumbnailText = '**افتار السيرفر**';
    if (session.thumbnailMode === 'none') thumbnailText = '**لا يوجد**';
    else if (session.thumbnailMode === 'user_avatar') thumbnailText = '**افتارك**';
    else if (session.thumbnailMode === 'custom') thumbnailText = session.customThumbnailUrl ? `**مخصص :** ${session.customThumbnailUrl}` : '**مخصص :** **غير محدد**';

    embedDetailsText =
      '\n\n**اعدادات الايمبد :**\n' +
      `**العنوان :** **${session.embedTitle || session.guildName || 'اسم السيرفر'}**\n` +
      `**الثمنيل :** ${thumbnailText}\n` +
      `**الفوتر :** **${session.embedFooter || session.guildName || 'اسم السيرفر'}**\n` +
      '**صورة الايمبد :**\n' +
      `${imageText}`;
  }

  const embed = colorManager.createEmbed()
    .setTitle('Say Manager')
    .setDescription(
      '**الكلام :**\n' +
      `${messageText}\n\n` +
      '**نوع الرسالة :**\n' +
      `${typeText}\n\n` +
      '**نوع الارسال :**\n' +
      `${targetTypeText}\n\n` +
      '**الشاتات المحددة :**\n' +
      `${channelsText}\n\n` +
      '**المستخدمون للخاص :**\n' +
      `${usersText}` +
      embedDetailsText
    )
    .setFooter({ text: statusText || 'اضبط الإعدادات ثم اضغط زر انهاء وارسال.' });

  return embed;
}

function buildMainComponents(sessionId) {
  const session = getSession(sessionId);
  const isEmbed = session?.type === 'embed';

  const firstRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`say_text_${sessionId}`).setLabel('الكلام').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`say_rooms_${sessionId}`).setLabel('الروم').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`say_dm_${sessionId}`).setLabel('للخاص').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`say_type_${sessionId}`).setLabel('النوع').setStyle(ButtonStyle.Secondary)
  );

  const secondRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`say_send_${sessionId}`).setLabel('انهاء وارسال').setStyle(ButtonStyle.Success)
  );

  if (isEmbed) {
    secondRow.addComponents(
      new ButtonBuilder().setCustomId(`say_embed_edit_${sessionId}`).setLabel('تعديل الايمبد').setStyle(ButtonStyle.Secondary)
    );
  }

  return [
    firstRow,
    secondRow
  ];
}

function buildProgressBar(current, total, size = 12) {
  const safeTotal = total > 0 ? total : 1;
  const ratio = Math.min(1, Math.max(0, current / safeTotal));
  const filled = Math.round(size * ratio);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, size - filled))}`;
  return `\`${bar}\` **${current}/${total}**`;
}

async function execute(message, args, { BOT_OWNERS = [] }) {
  if (!memberIsAdmin(message.member, BOT_OWNERS)) {
    await message.react('❌');
    return;
  }

  const sessionId = `${message.guild.id}_${message.author.id}_${Date.now()}`;
  const session = {
    id: sessionId,
    guildId: message.guild.id,
    userId: message.author.id,
    createdAt: Date.now(),
    text: '',
    type: 'normal',
    imageMode: 'none',
    customImageUrl: '',
    embedTitle: message.guild.name,
    embedFooter: message.guild.name,
    thumbnailMode: 'guild_avatar',
    customThumbnailUrl: '',
    channelIds: [message.channel.id],
    dmUserIds: [],
    guildName: message.guild.name,
    panelChannelId: message.channel.id,
    panelMessageId: null
  };
  saySessions.set(sessionId, session);

  const panelMessage = await message.channel.send({
    embeds: [buildDetailsEmbed(session)],
    components: buildMainComponents(sessionId)
  });

  session.panelMessageId = panelMessage.id;
}

function extractSessionId(customId) {
  const knownPrefixes = [
    'say_text_modal_',
    'say_embed_modal_',
    'say_type_select_',
    'say_rooms_select_',
    'say_dm_select_',
    'say_text_',
    'say_rooms_',
    'say_dm_',
    'say_type_',
    'say_embed_edit_',
    'say_send_'
  ];

  for (const prefix of knownPrefixes) {
    if (customId.startsWith(prefix)) return customId.slice(prefix.length);
  }

  return null;
}

function registerInteractionHandler(client) {
  if (client.__sayHandlersRegistered) return;
  client.__sayHandlersRegistered = true;

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.guild) return;

      const customId = interaction.customId || '';
      if (!customId.startsWith('say_')) return;

      const sessionId = extractSessionId(customId);
      if (!sessionId) return;

      const parts = customId.split('_');
      const action = parts[1];

      const session = getSession(sessionId);
      if (!session) {
        if (interaction.replied || interaction.deferred) return;
        await interaction.reply({ content: '❌ انتهت الجلسة، أعد تنفيذ الأمر.', ephemeral: true }).catch(() => {});
        return;
      }

      if (session.guildId !== interaction.guild.id) {
        await interaction.reply({ content: '❌ هذه الجلسة ليست لهذا السيرفر.', ephemeral: true }).catch(() => {});
        return;
      }

      const isAdmin = memberIsAdmin(interaction.member, global.BOT_OWNERS || []);
      if (!isAdmin) {
        await interaction.reply({ content: '❌ هذا الأمر للإدارة فقط.', ephemeral: true }).catch(() => {});
        return;
      }

      if (interaction.user.id !== session.userId) {
        await interaction.reply({ content: '❌ فقط منشئ اللوحة يمكنه التحكم بها.', ephemeral: true }).catch(() => {});
        return;
      }

      if (interaction.isButton()) {
        if (action === 'text') {
          const modal = new ModalBuilder().setCustomId(`say_text_modal_${sessionId}`).setTitle('تحديد الكلام');
          const textInput = new TextInputBuilder()
            .setCustomId('say_text_value')
            .setLabel('اكتب الكلام')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1900)
            .setValue(session.text || '');
          modal.addComponents(new ActionRowBuilder().addComponents(textInput));
          await interaction.showModal(modal);
          return;
        }

        if (action === 'rooms') {
          const row = new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId(`say_rooms_select_${sessionId}`)
              .setPlaceholder('اختر الرومات')
              .setMinValues(1)
              .setMaxValues(10)
              .addChannelTypes(ChannelType.GuildText)
          );
          await interaction.reply({ content: '**اختر الرومات المستهدفة :**', components: [row], ephemeral: true });
          return;
        }
        if (action === 'dm') {
          const row = new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder()
              .setCustomId(`say_dm_select_${sessionId}`)
              .setPlaceholder('اختر مستخدمين للخاص')
              .setMinValues(1)
              .setMaxValues(5)
          );
          await interaction.reply({ content: '**اختر المستخدمين للإرسال بالخاص (حد أقصى 5).**', components: [row], ephemeral: true });
          return;
        }

        if (action === 'type') {
          const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`say_type_select_${sessionId}`)
              .setPlaceholder('حدد نوع الرسالة')
              .addOptions([
                { label: 'رسالة عادية', value: 'normal', description: 'يتم الإرسال كنص عادي' },
                { label: 'ايمبد', value: 'embed', description: 'يتم الإرسال داخل ايمبد' }
              ])
          );
          await interaction.reply({ content: '**اختر النوع :**', components: [row], ephemeral: true });
          return;
        }

        if (action === 'embed' && parts[2] === 'edit') {
          if (session.type !== 'embed') {
            await interaction.reply({ content: '**هذا الخيار متاح فقط عند اختيار نوع ايمبد.**', ephemeral: true });
            return;
          }

          const modal = new ModalBuilder().setCustomId(`say_embed_modal_${sessionId}`).setTitle('تعديل اعدادات الايمبد');
          const titleInput = new TextInputBuilder()
            .setCustomId('say_embed_title')
            .setLabel('العنوان (0 للحذف)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(256)
            .setValue(session.embedTitle || '');
          const thumbInput = new TextInputBuilder()
            .setCustomId('say_embed_thumbnail')
            .setLabel('الثمنيل: guild / user / رابط / 0')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('guild أو user أو https://... أو 0')
            .setValue(
              session.thumbnailMode === 'custom'
                ? (session.customThumbnailUrl || '')
                : (session.thumbnailMode === 'user_avatar' ? 'user' : (session.thumbnailMode === 'none' ? '0' : 'guild'))
            );
          const footerInput = new TextInputBuilder()
            .setCustomId('say_embed_footer')
            .setLabel('الفوتر (0 للحذف)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(2048)
            .setValue(session.embedFooter || '');
          const imageInput = new TextInputBuilder()
            .setCustomId('say_embed_image')
            .setLabel('الصورة: guild / user / رابط / 0')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('guild أو user أو https://... أو 0')
            .setValue(session.imageMode === 'custom' ? (session.customImageUrl || '') : (session.imageMode === 'user_avatar' ? 'user' : (session.imageMode === 'guild_avatar' ? 'guild' : '0')));

          modal.addComponents(
            new ActionRowBuilder().addComponents(titleInput),
            new ActionRowBuilder().addComponents(thumbInput),
            new ActionRowBuilder().addComponents(footerInput),
            new ActionRowBuilder().addComponents(imageInput)
          );
          await interaction.showModal(modal);
          return;
        }

        if (action === 'send') {
          if (!session.text || !session.text.trim()) {
            await interaction.reply({ content: '❌ لازم تحدد الكلام أولاً.', ephemeral: true });
            return;
          }

          await interaction.deferUpdate();

          const sendAsDM = session.dmUserIds.length > 0;
          const targets = sendAsDM ? session.dmUserIds : (session.channelIds.length ? session.channelIds : [session.panelChannelId]);
          let success = 0;
          let failed = 0;
          let processed = 0;

          await interaction.message.edit({
            embeds: [buildDetailsEmbed(session, `**جاري الإرسال...**\n${buildProgressBar(processed, targets.length)}`)],
            components: []
          }).catch(() => {});

          for (const targetId of targets) {
            try {
              if (sendAsDM) {
                const user = await interaction.client.users.fetch(targetId).catch(() => null);
                if (!user) {
                  failed += 1;
                  continue;
                }

                if (session.type === 'embed') {
                  const guildIcon = interaction.guild.iconURL({ extension: 'png', size: 512 }) || interaction.guild.iconURL({ size: 512 });
                  const outEmbed = colorManager.createEmbed()
                    .setTitle(session.embedTitle || session.guildName || interaction.guild.name)
                    .setDescription(`**${session.text}**`)
                    .setFooter({ text: session.embedFooter || session.guildName || interaction.guild.name, iconURL: guildIcon || undefined });
                  if (session.thumbnailMode === 'guild_avatar' && guildIcon) outEmbed.setThumbnail(guildIcon);
                  if (session.thumbnailMode === 'user_avatar') outEmbed.setThumbnail(interaction.user.displayAvatarURL({ extension: 'png', size: 512 }));
                  if (session.thumbnailMode === 'custom' && session.customThumbnailUrl) outEmbed.setThumbnail(session.customThumbnailUrl);

                  if (session.imageMode === 'guild_avatar') {
                    if (guildIcon) outEmbed.setImage(guildIcon);
                  } else if (session.imageMode === 'user_avatar') {
                    outEmbed.setImage(interaction.user.displayAvatarURL({ extension: 'png', size: 512 }));
                  } else if (session.imageMode === 'custom' && session.customImageUrl) {
                    outEmbed.setImage(session.customImageUrl);
                  }

                  await user.send({ embeds: [outEmbed] });
                } else {
                  await user.send({ content: session.text });
                }
              } else {
                const ch = await interaction.guild.channels.fetch(targetId).catch(() => null);
                if (!ch || !ch.isTextBased()) {
                  failed += 1;
                  continue;
                }

                if (session.type === 'embed') {
                  const guildIcon = interaction.guild.iconURL({ extension: 'png', size: 512 }) || interaction.guild.iconURL({ size: 512 });
                  const outEmbed = colorManager.createEmbed()
                    .setTitle(session.embedTitle || session.guildName || interaction.guild.name)
                    .setDescription(`**${session.text}**`)
                    .setFooter({ text: session.embedFooter || session.guildName || interaction.guild.name, iconURL: guildIcon || undefined });
                  if (session.thumbnailMode === 'guild_avatar' && guildIcon) outEmbed.setThumbnail(guildIcon);
                  if (session.thumbnailMode === 'user_avatar') outEmbed.setThumbnail(interaction.user.displayAvatarURL({ extension: 'png', size: 512 }));
                  if (session.thumbnailMode === 'custom' && session.customThumbnailUrl) outEmbed.setThumbnail(session.customThumbnailUrl);

                  if (session.imageMode === 'guild_avatar') {
                    if (guildIcon) outEmbed.setImage(guildIcon);
                  } else if (session.imageMode === 'user_avatar') {
                    outEmbed.setImage(interaction.user.displayAvatarURL({ extension: 'png', size: 512 }));
                  } else if (session.imageMode === 'custom' && session.customImageUrl) {
                    outEmbed.setImage(session.customImageUrl);
                  }

                  await ch.send({ embeds: [outEmbed] });
                } else {
                  await ch.send({ content: session.text });
                }
              }
              success += 1;
            } catch {
              failed += 1;
            }
            processed += 1;
            if (processed === targets.length || processed % 2 === 0) {
              await interaction.message.edit({
                embeds: [buildDetailsEmbed(session, `**جاري الإرسال...**\n${buildProgressBar(processed, targets.length)}`)],
                components: []
              }).catch(() => {});
            }
          }

          const status = `**اكتمل الإرسال.**\n${buildProgressBar(targets.length, targets.length)}\n**نجاح:** ${success} | **فشل:** ${failed}`;
          saySessions.delete(session.id);

          await interaction.message.edit({
            embeds: [buildDetailsEmbed(session, status)],
            components: []
          }).catch(() => {});
          return;
        }
      }

      if (interaction.isStringSelectMenu()) {
        if (customId.startsWith('say_type_select_')) {
          session.type = interaction.values[0] === 'embed' ? 'embed' : 'normal';
          if (session.type === 'normal') {
            session.imageMode = 'none';
            session.customImageUrl = '';
          }

          await interaction.update({ content: `**تم تحديد النوع: ${session.type === 'embed' ? 'ايمبد' : 'رسالة عادية'}.**`, components: [] });

          const panelChannel = await interaction.guild.channels.fetch(session.panelChannelId).catch(() => null);
          if (panelChannel) {
            const panelMsg = await panelChannel.messages.fetch(session.panelMessageId).catch(() => null);
            if (panelMsg) await panelMsg.edit({ embeds: [buildDetailsEmbed(session)], components: buildMainComponents(session.id) }).catch(() => {});
          }
          return;
        }

      }

      if (interaction.isChannelSelectMenu() && customId.startsWith('say_rooms_select_')) {
        const validIds = interaction.values.slice(0, 10);
        const hadDmTargets = session.dmUserIds.length > 0;
        session.channelIds = validIds;
        if (session.dmUserIds.length > 0) session.dmUserIds = [];

        const roomUpdateMsg = hadDmTargets
          ? '**تم تحديث الرومات المحددة، وتم إلغاء وضع الخاص.**'
          : '**تم تحديث الرومات المحددة.**';
        await interaction.update({ content: roomUpdateMsg, components: [] });

        const panelChannel = await interaction.guild.channels.fetch(session.panelChannelId).catch(() => null);
        if (panelChannel) {
          const panelMsg = await panelChannel.messages.fetch(session.panelMessageId).catch(() => null);
          if (panelMsg) await panelMsg.edit({ embeds: [buildDetailsEmbed(session)], components: buildMainComponents(session.id) }).catch(() => {});
        }
        return;
      }

      if (interaction.isUserSelectMenu() && customId.startsWith('say_dm_select_')) {
        session.dmUserIds = interaction.values.slice(0, 5);
        session.channelIds = [];

        await interaction.update({ content: '**تم تحديد مستلمي الخاص، وتم إلغاء اختيار الرومات.**', components: [] });

        const panelChannel = await interaction.guild.channels.fetch(session.panelChannelId).catch(() => null);
        if (panelChannel) {
          const panelMsg = await panelChannel.messages.fetch(session.panelMessageId).catch(() => null);
          if (panelMsg) await panelMsg.edit({ embeds: [buildDetailsEmbed(session)], components: buildMainComponents(session.id) }).catch(() => {});
        }
        return;
      }

      if (interaction.isModalSubmit()) {
        if (customId.startsWith('say_text_modal_')) {
          const text = interaction.fields.getTextInputValue('say_text_value').trim();
          if (!text) {
            await interaction.reply({ content: '❌ الكلام لا يمكن يكون فاضي.', ephemeral: true });
            return;
          }

          session.text = text;
          await interaction.reply({ content: '**تم حفظ الكلام.**', ephemeral: true });

          const panelChannel = await interaction.guild.channels.fetch(session.panelChannelId).catch(() => null);
          if (panelChannel) {
            const panelMsg = await panelChannel.messages.fetch(session.panelMessageId).catch(() => null);
            if (panelMsg) await panelMsg.edit({ embeds: [buildDetailsEmbed(session)], components: buildMainComponents(session.id) }).catch(() => {});
          }
          return;
        }

        if (customId.startsWith('say_embed_modal_')) {
          if (session.type !== 'embed') {
            await interaction.reply({ content: '**لازم يكون نوع الرسالة ايمبد أولاً.**', ephemeral: true });
            return;
          }

          const titleRaw = interaction.fields.getTextInputValue('say_embed_title').trim();
          const thumbRaw = interaction.fields.getTextInputValue('say_embed_thumbnail').trim().toLowerCase();
          const footerRaw = interaction.fields.getTextInputValue('say_embed_footer').trim();
          const imageRaw = interaction.fields.getTextInputValue('say_embed_image').trim().toLowerCase();

          if (titleRaw === '0') session.embedTitle = '';
          else if (titleRaw.length) session.embedTitle = titleRaw;

          if (footerRaw === '0') session.embedFooter = '';
          else if (footerRaw.length) session.embedFooter = footerRaw;

          if (thumbRaw === '0' || thumbRaw === 'none') {
            session.thumbnailMode = 'none';
            session.customThumbnailUrl = '';
          } else if (thumbRaw === 'guild') {
            session.thumbnailMode = 'guild_avatar';
            session.customThumbnailUrl = '';
          } else if (thumbRaw === 'user') {
            session.thumbnailMode = 'user_avatar';
            session.customThumbnailUrl = '';
          } else if (thumbRaw) {
            if (!/^https?:\/\//i.test(thumbRaw)) {
              await interaction.reply({ content: '**رابط الثمنيل غير صالح.**', ephemeral: true });
              return;
            }
            session.thumbnailMode = 'custom';
            session.customThumbnailUrl = thumbRaw;
          }

          if (imageRaw === '0' || imageRaw === 'none') {
            session.imageMode = 'none';
            session.customImageUrl = '';
          } else if (imageRaw === 'guild') {
            session.imageMode = 'guild_avatar';
            session.customImageUrl = '';
          } else if (imageRaw === 'user') {
            session.imageMode = 'user_avatar';
            session.customImageUrl = '';
          } else if (imageRaw) {
            if (!/^https?:\/\//i.test(imageRaw)) {
              await interaction.reply({ content: '**رابط الصورة غير صالح.**', ephemeral: true });
              return;
            }
            session.imageMode = 'custom';
            session.customImageUrl = imageRaw;
          }
          await interaction.reply({ content: '**تم تحديث إعدادات الايمبد.**', ephemeral: true });

          const panelChannel = await interaction.guild.channels.fetch(session.panelChannelId).catch(() => null);
          if (panelChannel) {
            const panelMsg = await panelChannel.messages.fetch(session.panelMessageId).catch(() => null);
            if (panelMsg) await panelMsg.edit({ embeds: [buildDetailsEmbed(session)], components: buildMainComponents(session.id) }).catch(() => {});
          }
          return;
        }
      }
    } catch (error) {
      console.error('Say interaction error:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ حدث خطأ أثناء تنفيذ العملية.', ephemeral: true }).catch(() => {});
      }
    }
  });
}

module.exports = {
  name,
  aliases,
  execute,
  registerInteractionHandler
};
