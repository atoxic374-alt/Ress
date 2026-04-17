const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  StringSelectMenuBuilder,
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

  const embedTitleText = session.embedTitle ? `**${session.embedTitle}**` : '**غير محدد**';
  const embedFooterText = session.embedFooter ? `**${session.embedFooter}**` : '**غير محدد**';

  let imageText = '**لا يوجد**';
  if (session.type === 'embed') {
    if (session.thumbnailMode === 'guild_avatar') imageText = '**ثمنيل من افتار السيرفر**';
    else if (session.thumbnailMode === 'user_avatar') imageText = '**ثمنيل من افتارك**';
    else if (session.thumbnailMode === 'custom') imageText = session.customThumbnailUrl ? `**ثمنيل مخصص :** ${session.customThumbnailUrl}` : '**ثمنيل مخصص :** **غير محدد**';
  }
  const mentions = Array.isArray(session.embedMentions) ? session.embedMentions : [];
  const orderedMentions = ['here', 'everyone'].filter(type => mentions.includes(type));
  const mentionText = orderedMentions.length
    ? orderedMentions.map(type => (type === 'here' ? '@here' : '@everyone')).join(' | ')
    : '**بدون منشن**';

  const messageText = session.text ? `**${session.text}**` : '**غير محدد**';

  const embed = colorManager.createEmbed()
    .setTitle('Say Manager')
    .setDescription(
      '**الكلام :**\n' +
      `${messageText}\n\n` +
      '**نوع الرسالة :**\n' +
      `${session.type === 'embed' ? '**ايمبد**' : '**رسالة عادية**'}\n\n` +
      '**عنوان الايمبد :**\n' +
      `${embedTitleText}\n\n` +
      '**فوتر الايمبد :**\n' +
      `${embedFooterText}\n\n` +
      '**ثمنيل الايمبد :**\n' +
      `${imageText}\n\n` +
      '**منشن الايمبد :**\n' +
      `${mentionText}\n\n` +
      '**الشاتات المحددة :**\n' +
      `${channelsText}`
    )
    .setFooter({ text: statusText || 'اضبط الإعدادات ثم اضغط زر انهاء وارسال.' });

  return embed;
}

function buildEmbedEditorEmbed(session) {
  const mentions = Array.isArray(session.embedMentions) ? session.embedMentions : [];
  const orderedMentions = ['here', 'everyone'].filter(type => mentions.includes(type));
  const mentionText = orderedMentions.length
    ? orderedMentions.map(type => (type === 'here' ? '@here' : '@everyone')).join(' | ')
    : 'بدون منشن';

  const thumbnailText = session.thumbnailMode === 'guild_avatar'
    ? 'ثمنيل من افتار السيرفر'
    : session.thumbnailMode === 'user_avatar'
      ? 'ثمنيل من افتارك'
      : session.thumbnailMode === 'custom'
        ? (session.customThumbnailUrl || 'ثمنيل مخصص غير محدد')
        : 'بدون ثمنيل';

  return colorManager.createEmbed()
    .setTitle('تعديل الايمبد')
    .setDescription('اختر الخيار للتعديل ثم اضغط **انهاء تعديل الايمبد** لحفظ التعديلات والعودة.')
    .addFields(
      { name: 'العنوان', value: session.embedTitle || 'غير محدد', inline: false },
      { name: 'الفوتر', value: session.embedFooter || 'غير محدد', inline: false },
      { name: 'الثمنيل', value: thumbnailText, inline: false },
      { name: 'المنشن', value: mentionText, inline: false }
    );
}

function buildEmbedEditorComponents(sessionId) {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`say_embed_edit_select_${sessionId}`)
        .setPlaceholder('اختر العنصر المطلوب تعديله')
        .addOptions([
          { label: 'تعديل العنوان', value: 'title', description: 'تحديد عنوان الايمبد' },
          { label: 'تعديل الفوتر', value: 'footer', description: 'تحديد فوتر الايمبد' },
          { label: 'ثمنيل من افتار السيرفر', value: 'thumb_guild', description: 'استخدام أيقونة السيرفر كثمنيل' },
          { label: 'ثمنيل من افتارك', value: 'thumb_user', description: 'استخدام صورتك الشخصية كثمنيل' },
          { label: 'ثمنيل مخصص', value: 'thumb_custom', description: 'إدخال رابط ثمنيل مخصص' },
          { label: 'حذف الثمنيل', value: 'thumb_none', description: 'إزالة الثمنيل من الايمبد' },
          { label: 'منشن', value: 'mention', description: 'تعديل منشن @here / @everyone' }
        ])
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`say_embed_edit_done_${sessionId}`)
        .setLabel('انهاء تعديل الايمبد')
        .setStyle(ButtonStyle.Success)
    )
  ];
}

function buildMainComponents(sessionId) {
  const session = getSession(sessionId);
  const firstRowButtons = [
    new ButtonBuilder().setCustomId(`say_text_${sessionId}`).setLabel('الكلام').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`say_rooms_${sessionId}`).setLabel('الروم').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`say_type_${sessionId}`).setLabel('النوع').setStyle(ButtonStyle.Secondary)
  ];

  if (session?.type === 'embed') {
    firstRowButtons.push(
      new ButtonBuilder().setCustomId(`say_embed_edit_${sessionId}`).setLabel('تعديل الايمبد').setStyle(ButtonStyle.Secondary)
    );
  }

  return [
    new ActionRowBuilder().addComponents(firstRowButtons),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`say_send_${sessionId}`).setLabel('انهاء وارسال').setStyle(ButtonStyle.Success)
    )
  ];
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
    embedTitle: '',
    embedFooter: '',
    thumbnailMode: 'none',
    customThumbnailUrl: '',
    embedMentions: [],
    channelIds: [message.channel.id],
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
    'say_embed_title_modal_',
    'say_embed_footer_modal_',
    'say_embed_thumbnail_modal_',
    'say_embed_mention_select_',
    'say_embed_edit_done_',
    'say_embed_edit_select_',
    'say_embed_edit_',
    'say_type_select_',
    'say_rooms_select_',
    'say_text_',
    'say_rooms_',
    'say_type_',
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

        if (customId.startsWith('say_embed_edit_')) {
          if (customId.startsWith('say_embed_edit_done_')) {
            await interaction.update({
              content: '✅ تم تثبيت تعديلات الايمبد. تم الرجوع للقائمة الرئيسية.',
              embeds: [],
              components: []
            });
            return;
          }

          if (session.type !== 'embed') {
            await interaction.reply({ content: '⚠️ تعديل الايمبد متاح فقط عندما نوع الرسالة **ايمبد**.', ephemeral: true });
            return;
          }

          await interaction.reply({
            embeds: [buildEmbedEditorEmbed(session)],
            components: buildEmbedEditorComponents(sessionId),
            ephemeral: true
          });
          return;
        }

        if (action === 'send') {
          if (!session.text || !session.text.trim()) {
            await interaction.reply({ content: '❌ لازم تحدد الكلام أولاً.', ephemeral: true });
            return;
          }

          const targets = session.channelIds.length ? session.channelIds : [session.panelChannelId];
          let success = 0;
          let failed = 0;

          for (const channelId of targets) {
            const ch = await interaction.guild.channels.fetch(channelId).catch(() => null);
            if (!ch || !ch.isTextBased()) {
              failed += 1;
              continue;
            }

            try {
              if (session.type === 'embed') {
                const outEmbed = colorManager.createEmbed().setDescription(`**${session.text}**`);
                if (session.embedTitle) outEmbed.setTitle(session.embedTitle);
                if (session.embedFooter) outEmbed.setFooter({ text: session.embedFooter });

                if (session.thumbnailMode === 'guild_avatar') {
                  const guildIcon = interaction.guild.iconURL({ extension: 'png', size: 512 });
                  if (guildIcon) outEmbed.setThumbnail(guildIcon);
                } else if (session.thumbnailMode === 'user_avatar') {
                  outEmbed.setThumbnail(interaction.user.displayAvatarURL({ extension: 'png', size: 512 }));
                } else if (session.thumbnailMode === 'custom' && session.customThumbnailUrl) {
                  outEmbed.setThumbnail(session.customThumbnailUrl);
                }
                const mentionText = ['here', 'everyone']
                  .filter(type => (Array.isArray(session.embedMentions) ? session.embedMentions : []).includes(type))
                  .map(type => (type === 'here' ? '@here' : '@everyone'))
                  .join(' | ');
                const payload = { embeds: [outEmbed] };
                if (mentionText) {
                  payload.content = mentionText;
                  payload.allowedMentions = { parse: ['everyone'] };
                }
                await ch.send(payload);
              } else {
                await ch.send({ content: session.text });
              }
              success += 1;
            } catch {
              failed += 1;
            }
          }

          const status = `تم الإرسال بنجاح : ${success} | فشل : ${failed}`;
          saySessions.delete(session.id);

          await interaction.update({
            embeds: [buildDetailsEmbed(session, status)],
            components: []
          });
          return;
        }
      }

      if (interaction.isStringSelectMenu()) {
        if (customId.startsWith('say_type_select_')) {
          session.type = interaction.values[0] === 'embed' ? 'embed' : 'normal';
          if (session.type === 'normal') {
            session.embedTitle = '';
            session.embedFooter = '';
            session.thumbnailMode = 'none';
            session.customThumbnailUrl = '';
            session.embedMentions = [];
          }

          await interaction.update({ content: `✅ تم تحديد النوع : **${session.type === 'embed' ? 'ايمبد' : 'رسالة عادية'}**`, components: [] });

          const panelChannel = await interaction.guild.channels.fetch(session.panelChannelId).catch(() => null);
          if (panelChannel) {
            const panelMsg = await panelChannel.messages.fetch(session.panelMessageId).catch(() => null);
            if (panelMsg) await panelMsg.edit({ embeds: [buildDetailsEmbed(session)], components: buildMainComponents(session.id) }).catch(() => {});
          }
          return;
        }

        if (customId.startsWith('say_embed_edit_select_')) {
          const selected = interaction.values[0];
          if (selected === 'title') {
            const modal = new ModalBuilder().setCustomId(`say_embed_title_modal_${sessionId}`).setTitle('تعديل عنوان الايمبد');
            const input = new TextInputBuilder()
              .setCustomId('say_embed_title')
              .setLabel('عنوان الايمبد')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(256)
              .setValue(session.embedTitle || '');
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
            return;
          }

          if (selected === 'footer') {
            const modal = new ModalBuilder().setCustomId(`say_embed_footer_modal_${sessionId}`).setTitle('تعديل فوتر الايمبد');
            const input = new TextInputBuilder()
              .setCustomId('say_embed_footer')
              .setLabel('فوتر الايمبد')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(2048)
              .setValue(session.embedFooter || '');
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
            return;
          }

          if (selected === 'thumb_custom') {
            const modal = new ModalBuilder().setCustomId(`say_embed_thumbnail_modal_${sessionId}`).setTitle('رابط ثمنيل الايمبد');
            const input = new TextInputBuilder()
              .setCustomId('say_embed_thumbnail_url')
              .setLabel('رابط الثمنيل')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setPlaceholder('https://example.com/image.png');
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
            return;
          }

          if (selected === 'mention') {
            const row = new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId(`say_embed_mention_select_${sessionId}`)
                .setPlaceholder('حدد نوع المنشن')
                .setMinValues(1)
                .setMaxValues(2)
                .addOptions([
                  { label: '@here', value: 'here', description: 'تنبيه الأعضاء المتصلين حالياً' },
                  { label: '@everyone', value: 'everyone', description: 'تنبيه جميع أعضاء السيرفر' }
                ])
            );
            await interaction.update({
              embeds: [buildEmbedEditorEmbed(session)],
              components: [
                row,
                new ActionRowBuilder().addComponents(
                  new ButtonBuilder()
                    .setCustomId(`say_embed_edit_done_${sessionId}`)
                    .setLabel('انهاء تعديل الايمبد')
                    .setStyle(ButtonStyle.Success)
                )
              ]
            });
            return;
          }

          if (selected === 'thumb_guild') {
            session.thumbnailMode = 'guild_avatar';
            session.customThumbnailUrl = '';
          } else if (selected === 'thumb_user') {
            session.thumbnailMode = 'user_avatar';
            session.customThumbnailUrl = '';
          } else if (selected === 'thumb_none') {
            session.thumbnailMode = 'none';
            session.customThumbnailUrl = '';
          }

          await interaction.update({
            content: '✅ تم تحديث إعدادات الايمبد.',
            embeds: [buildEmbedEditorEmbed(session)],
            components: buildEmbedEditorComponents(sessionId)
          });

          const panelChannel = await interaction.guild.channels.fetch(session.panelChannelId).catch(() => null);
          if (panelChannel) {
            const panelMsg = await panelChannel.messages.fetch(session.panelMessageId).catch(() => null);
            if (panelMsg) await panelMsg.edit({ embeds: [buildDetailsEmbed(session)], components: buildMainComponents(session.id) }).catch(() => {});
          }
          return;
        }

        if (customId.startsWith('say_embed_mention_select_')) {
          const values = Array.from(new Set(interaction.values.filter(value => value === 'here' || value === 'everyone')));
          session.embedMentions = values;

          await interaction.update({
            content: '✅ تم تحديث المنشن.',
            embeds: [buildEmbedEditorEmbed(session)],
            components: buildEmbedEditorComponents(sessionId)
          });

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
        session.channelIds = validIds;

        await interaction.update({ content: '✅ تم تحديث الرومات المحددة.', components: [] });

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
          await interaction.reply({ content: '✅ تم حفظ الكلام.', ephemeral: true });

          const panelChannel = await interaction.guild.channels.fetch(session.panelChannelId).catch(() => null);
          if (panelChannel) {
            const panelMsg = await panelChannel.messages.fetch(session.panelMessageId).catch(() => null);
            if (panelMsg) await panelMsg.edit({ embeds: [buildDetailsEmbed(session)], components: buildMainComponents(session.id) }).catch(() => {});
          }
          return;
        }

        if (customId.startsWith('say_embed_title_modal_')) {
          if (session.type !== 'embed') {
            await interaction.reply({ content: '❌ لازم يكون نوع الرسالة ايمبد أولاً.', ephemeral: true });
            return;
          }

          const title = interaction.fields.getTextInputValue('say_embed_title').trim();
          session.embedTitle = title;
          await interaction.reply({ content: '✅ تم حفظ عنوان الايمبد.', ephemeral: true });

          const panelChannel = await interaction.guild.channels.fetch(session.panelChannelId).catch(() => null);
          if (panelChannel) {
            const panelMsg = await panelChannel.messages.fetch(session.panelMessageId).catch(() => null);
            if (panelMsg) await panelMsg.edit({ embeds: [buildDetailsEmbed(session)], components: buildMainComponents(session.id) }).catch(() => {});
          }
          return;
        }

        if (customId.startsWith('say_embed_footer_modal_')) {
          if (session.type !== 'embed') {
            await interaction.reply({ content: '❌ لازم يكون نوع الرسالة ايمبد أولاً.', ephemeral: true });
            return;
          }

          const footer = interaction.fields.getTextInputValue('say_embed_footer').trim();
          session.embedFooter = footer;
          await interaction.reply({ content: '✅ تم حفظ فوتر الايمبد.', ephemeral: true });

          const panelChannel = await interaction.guild.channels.fetch(session.panelChannelId).catch(() => null);
          if (panelChannel) {
            const panelMsg = await panelChannel.messages.fetch(session.panelMessageId).catch(() => null);
            if (panelMsg) await panelMsg.edit({ embeds: [buildDetailsEmbed(session)], components: buildMainComponents(session.id) }).catch(() => {});
          }
          return;
        }

        if (customId.startsWith('say_embed_thumbnail_modal_')) {
          if (session.type !== 'embed') {
            await interaction.reply({ content: '❌ لازم يكون نوع الرسالة ايمبد أولاً.', ephemeral: true });
            return;
          }

          const url = interaction.fields.getTextInputValue('say_embed_thumbnail_url').trim();
          if (!/^https?:\/\//i.test(url)) {
            await interaction.reply({ content: '❌ رابط الصورة غير صالح.', ephemeral: true });
            return;
          }

          session.thumbnailMode = 'custom';
          session.customThumbnailUrl = url;

          await interaction.reply({ content: '✅ تم حفظ ثمنيل الايمبد المخصص.', ephemeral: true });

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
