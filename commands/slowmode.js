const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField
} = require('discord.js');
const colorManager = require('../utils/colorManager');
const { memberIsAdmin } = require('./store');

const sessions = new Map();

function formatSeconds(seconds) {
  const value = Number(seconds || 0);
  if (value <= 0) return '0s';
  if (value % 3600 === 0) return `${value / 3600}h`;
  if (value % 60 === 0) return `${value / 60}m`;
  return `${value}s`;
}

function renderEmbed(guild, mapping, note = '') {
  const entries = Object.entries(mapping || {});
  const rows = entries.length
    ? entries.map(([channelId, seconds], i) => `**${i + 1}.** <#${channelId}> - **${formatSeconds(seconds)}**`).join('\n')
    : '**لا يوجد إعدادات حالياً.**';

  return colorManager.createEmbed()
    .setAuthor({ name: guild.name, iconURL: guild.iconURL({ dynamic: true }) || undefined })
    .setTitle('Slowmode Manager')
    .setDescription('**الرومات المحددة والأوقات :**\n' + rows + (note ? `\n\n**${note}**` : ''))
    .setTimestamp();
}

function renderComponents(sessionId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`slowmode_add_${sessionId}`).setLabel('إضافة').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`slowmode_remove_${sessionId}`).setLabel('إزالة').setStyle(ButtonStyle.Danger)
    )
  ];
}

module.exports = {
  name: 'slowmode',
  aliases: ['بطيء'],

  async execute(message, args, { BOT_OWNERS = [] }) {
    if (!memberIsAdmin(message.member, BOT_OWNERS)) {
      await message.react('❌').catch(() => {});
      return;
    }

    if (!message.guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      await message.reply('**❌ البوت يحتاج صلاحية Manage Channels.**');
      return;
    }

    const sessionId = `${message.guild.id}_${message.author.id}_${Date.now()}`;
    const session = {
      guildId: message.guild.id,
      userId: message.author.id,
      channels: {},
      panelChannelId: message.channel.id,
      panelMessageId: null
    };
    sessions.set(sessionId, session);

    const panel = await message.reply({
      embeds: [renderEmbed(message.guild, {})],
      components: renderComponents(sessionId)
    });
    session.panelMessageId = panel.id;
  },

  registerInteractionHandler(client) {
    if (client.__slowmodeHandlerRegistered) return;
    client.__slowmodeHandlerRegistered = true;

    client.on('interactionCreate', async (interaction) => {
      try {
        const customId = String(interaction.customId || '');
        if (!customId.startsWith('slowmode_')) return;
        if (!interaction.guild) return;

        if (interaction.isButton()) {
          const [, action, sessionId] = customId.split('_');
          const session = sessions.get(sessionId);
          if (!session || session.guildId !== interaction.guild.id) {
            await interaction.reply({ content: '**❌ انتهت الجلسة.**', ephemeral: true });
            return;
          }
          if (session.userId !== interaction.user.id) {
            await interaction.reply({ content: '**❌ هذه الجلسة خاصة بمنشئها.**', ephemeral: true });
            return;
          }

          if (action === 'add') {
            const row = new ActionRowBuilder().addComponents(
              new ChannelSelectMenuBuilder()
                .setCustomId(`slowmode_add_channels_${sessionId}`)
                .setPlaceholder('ابحث واختر الرومات')
                .setMinValues(1)
                .setMaxValues(10)
                .addChannelTypes(ChannelType.GuildText)
            );
            await interaction.reply({ content: '**اختر الرومات للإضافة.**', components: [row], ephemeral: true });
            return;
          }

          if (action === 'remove') {
            const current = Object.keys(session.channels);
            if (!current.length) {
              await interaction.reply({ content: '**❌ لا يوجد رومات محددة للإزالة.**', ephemeral: true });
              return;
            }

            const options = current.slice(0, 25).map((ch) => ({
              label: interaction.guild.channels.cache.get(ch)?.name?.slice(0, 100) || ch,
              value: ch,
              description: `الوقت الحالي : ${formatSeconds(session.channels[ch])}`
            }));

            const row = new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId(`slowmode_remove_pick_${sessionId}`)
                .setPlaceholder('اختر الرومات للإزالة')
                .setMinValues(1)
                .setMaxValues(options.length)
                .addOptions(options)
            );

            await interaction.reply({ content: '**اختر المحدد الذي تريد إزالته.**', components: [row], ephemeral: true });
            return;
          }
        }

        if (interaction.isChannelSelectMenu() && customId.startsWith('slowmode_add_channels_')) {
          const sessionId = customId.replace('slowmode_add_channels_', '');
          const session = sessions.get(sessionId);
          if (!session || session.userId !== interaction.user.id) {
            await interaction.update({ content: '**❌ انتهت الجلسة.**', components: [] });
            return;
          }

          session.pendingChannels = interaction.values;

          const modal = new ModalBuilder().setCustomId(`slowmode_add_modal_${sessionId}`).setTitle('مدة السلومود');
          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('slowmode_seconds')
                .setLabel('الوقت بالثواني')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder('10')
            )
          );
          await interaction.showModal(modal);
          return;
        }

        if (interaction.isStringSelectMenu() && customId.startsWith('slowmode_remove_pick_')) {
          const sessionId = customId.replace('slowmode_remove_pick_', '');
          const session = sessions.get(sessionId);
          if (!session || session.userId !== interaction.user.id) {
            await interaction.update({ content: '**❌ انتهت الجلسة.**', components: [] });
            return;
          }

          for (const channelId of interaction.values) {
            const channel = interaction.guild.channels.cache.get(channelId);
            if (channel && channel.type === ChannelType.GuildText) {
              await channel.setRateLimitPerUser(0, `Slowmode remove by ${interaction.user.tag}`).catch(() => {});
            }
            delete session.channels[channelId];
          }

          await interaction.update({ content: '**✅ تم إزالة السلومود من المحدد.**', components: [] });

          const panelChannel = await interaction.guild.channels.fetch(session.panelChannelId).catch(() => null);
          const panelMessage = panelChannel && panelChannel.isTextBased() ? await panelChannel.messages.fetch(session.panelMessageId).catch(() => null) : null;
          if (panelMessage) await panelMessage.edit({ embeds: [renderEmbed(interaction.guild, session.channels)], components: renderComponents(sessionId) }).catch(() => {});
          return;
        }

        if (interaction.isModalSubmit() && customId.startsWith('slowmode_add_modal_')) {
          const sessionId = customId.replace('slowmode_add_modal_', '');
          const session = sessions.get(sessionId);
          if (!session || session.userId !== interaction.user.id) {
            await interaction.reply({ content: '**❌ انتهت الجلسة.**', ephemeral: true });
            return;
          }

          const seconds = Number(interaction.fields.getTextInputValue('slowmode_seconds').trim());
          if (!Number.isFinite(seconds) || seconds < 0 || seconds > 21600) {
            await interaction.reply({ content: '**❌ الوقت غير صالح. المسموح من 0 إلى 21600 ثانية.**', ephemeral: true });
            return;
          }

          const channels = session.pendingChannels || [];
          delete session.pendingChannels;
          for (const channelId of channels) {
            const channel = interaction.guild.channels.cache.get(channelId);
            if (!channel || channel.type !== ChannelType.GuildText) continue;
            await channel.setRateLimitPerUser(seconds, `Slowmode set by ${interaction.user.tag}`).catch(() => {});
            session.channels[channelId] = seconds;
          }

          await interaction.reply({ content: '**✅ تم تطبيق السلومود على الرومات المحددة.**', ephemeral: true });

          const panelChannel = await interaction.guild.channels.fetch(session.panelChannelId).catch(() => null);
          const panelMessage = panelChannel && panelChannel.isTextBased() ? await panelChannel.messages.fetch(session.panelMessageId).catch(() => null) : null;
          if (panelMessage) await panelMessage.edit({ embeds: [renderEmbed(interaction.guild, session.channels)], components: renderComponents(sessionId) }).catch(() => {});
        }
      } catch (error) {
        console.error('slowmode interaction error:', error);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '**❌ حدث خطأ أثناء العملية.**', ephemeral: true }).catch(() => {});
        }
      }
    });
  }
};
