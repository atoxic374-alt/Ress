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

  let imageText = '**لا يوجد**';
  if (session.type === 'embed') {
    if (session.imageMode === 'guild_avatar') imageText = '**صورة افتار السيرفر**';
    else if (session.imageMode === 'user_avatar') imageText = '**صورة افتارك**';
    else if (session.imageMode === 'custom') imageText = session.customImageUrl ? `**مخصص :** ${session.customImageUrl}` : '**مخصص :** **غير محدد**';
  }

  const messageText = session.text ? `**${session.text}**` : '**غير محدد**';

  const embed = colorManager.createEmbed()
    .setTitle('Say Manager')
    .setDescription(
      '**الكلام :**\n' +
      `${messageText}\n\n` +
      '**نوع الرسالة :**\n' +
      `${session.type === 'embed' ? '**ايمبد**' : '**رسالة عادية**'}\n\n` +
      '**صورة الايمبد :**\n' +
      `${imageText}\n\n` +
      '**الشاتات المحددة :**\n' +
      `${channelsText}`
    )
    .setFooter({ text: statusText || 'اضبط الإعدادات ثم اضغط زر انهاء وارسال.' });

  return embed;
}

function buildMainComponents(sessionId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`say_text_${sessionId}`).setLabel('الكلام').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`say_rooms_${sessionId}`).setLabel('الروم').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`say_type_${sessionId}`).setLabel('النوع').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`say_image_${sessionId}`).setLabel('صورة الايمبد').setStyle(ButtonStyle.Secondary)
    ),
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
    imageMode: 'none',
    customImageUrl: '',
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

function registerInteractionHandler(client) {
  if (client.__sayHandlersRegistered) return;
  client.__sayHandlersRegistered = true;

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.guild) return;

      const customId = interaction.customId || '';
      if (!customId.startsWith('say_')) return;

      const parts = customId.split('_');
      const action = parts[1];
      const sessionId = parts.slice(2).join('_');

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

        if (action === 'image') {
          if (session.type !== 'embed') {
            await interaction.reply({ content: '⚠️ صورة الايمبد متاحة فقط عندما نوع الرسالة **ايمبد**.', ephemeral: true });
            return;
          }

          const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`say_image_select_${sessionId}`)
              .setPlaceholder('اختر مصدر الصورة')
              .addOptions([
                { label: 'افتار السيرفر', value: 'guild_avatar', description: 'استخدام أيقونة السيرفر' },
                { label: 'افتارك', value: 'user_avatar', description: 'استخدام صورتك الشخصية' },
                { label: 'صورة مخصصة', value: 'custom', description: 'إدخال رابط صورة' },
                { label: 'بدون صورة', value: 'none', description: 'إزالة صورة الايمبد' }
              ])
          );
          await interaction.reply({ content: '**حدد صورة الايمبد :**', components: [row], ephemeral: true });
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

                if (session.imageMode === 'guild_avatar') {
                  const guildIcon = interaction.guild.iconURL({ extension: 'png', size: 512 });
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
            session.imageMode = 'none';
            session.customImageUrl = '';
          }

          await interaction.update({ content: `✅ تم تحديد النوع : **${session.type === 'embed' ? 'ايمبد' : 'رسالة عادية'}**`, components: [] });

          const panelChannel = await interaction.guild.channels.fetch(session.panelChannelId).catch(() => null);
          if (panelChannel) {
            const panelMsg = await panelChannel.messages.fetch(session.panelMessageId).catch(() => null);
            if (panelMsg) await panelMsg.edit({ embeds: [buildDetailsEmbed(session)], components: buildMainComponents(session.id) }).catch(() => {});
          }
          return;
        }

        if (customId.startsWith('say_image_select_')) {
          const selected = interaction.values[0];

          if (selected === 'custom') {
            const modal = new ModalBuilder().setCustomId(`say_image_modal_${sessionId}`).setTitle('رابط صورة الايمبد');
            const input = new TextInputBuilder()
              .setCustomId('say_image_url')
              .setLabel('رابط الصورة')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setPlaceholder('https://example.com/image.png');
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
            return;
          }

          session.imageMode = selected;
          if (selected !== 'custom') session.customImageUrl = '';

          await interaction.update({ content: '✅ تم تحديث صورة الايمبد.', components: [] });

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

        if (customId.startsWith('say_image_modal_')) {
          if (session.type !== 'embed') {
            await interaction.reply({ content: '❌ لازم يكون نوع الرسالة ايمبد أولاً.', ephemeral: true });
            return;
          }

          const url = interaction.fields.getTextInputValue('say_image_url').trim();
          if (!/^https?:\/\//i.test(url)) {
            await interaction.reply({ content: '❌ رابط الصورة غير صالح.', ephemeral: true });
            return;
          }

          session.imageMode = 'custom';
          session.customImageUrl = url;

          await interaction.reply({ content: '✅ تم حفظ صورة الايمبد المخصصة.', ephemeral: true });

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
