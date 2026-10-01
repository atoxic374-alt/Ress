const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  StringSelectMenuBuilder,
  ChannelType
} = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const {
  getGuildSettings,
  updateGuildSettings,
  normalizeId
} = require('../utils/reactionLogManager');

const name = 'reactionlog';
const aliases = ['لوق-رياكشن', 'لوق_رياكشن', 'رياكشن-لوق'];
const PANEL_PREFIX = 'reactionlog_';

function isAllowed(interactionOrMessage, BOT_OWNERS = []) {
  const guild = interactionOrMessage?.guild;
  const user = interactionOrMessage?.user || interactionOrMessage?.author;
  const member = interactionOrMessage?.member;
  return Boolean(
    guild && user &&
    (guild.ownerId === user.id ||
      BOT_OWNERS.map(String).includes(String(user.id)) ||
      member?.permissions?.has?.('Administrator'))
  );
}

function getThumbnail(guild, client) {
  return client?.user?.displayAvatarURL?.({ dynamic: true, size: 256 }) ||
    guild?.iconURL?.({ dynamic: true, size: 256 }) || null;
}

function recipientLines(settings) {
  if (!settings.recipientIds.length) return 'No recipients configured.';
  return settings.recipientIds.map((id, index) => `${index + 1}. <@${id}>`).join('\n');
}

function channelLine(settings) {
  return settings.channelId ? `<#${settings.channelId}>` : 'All channels';
}

function eventModeLine(settings) {
  return { add: 'Added only', remove: 'Removed only', both: 'Added and removed' }[settings.eventMode] || 'Added and removed';
}

function buildPanel(guild, client) {
  const settings = getGuildSettings(guild.id);
  const embed = colorManager.createEmbed()
    .setTitle('Reaction Log')
    .setDescription(
      '**Reaction activity panel**\n\n' +
      'Private logs are sent when a reaction is added or removed.\n\n' +
      `Status: **${settings.enabled ? 'Enabled' : 'Disabled'}**`
    )
    .addFields(
      { name: 'Recipients', value: recipientLines(settings), inline: false },
      { name: 'Channel', value: channelLine(settings), inline: true },
      { name: 'Count', value: `\`${settings.recipientIds.length}\``, inline: true },
      { name: 'Events', value: eventModeLine(settings), inline: true },
      { name: 'Delivery', value: 'Private messages', inline: true }
    )
    .setFooter({ text: `${guild.name} • Reaction Log` })
    .setTimestamp();

  const thumbnail = getThumbnail(guild, client);
  if (thumbnail) embed.setThumbnail(thumbnail);

  const addUsers = new UserSelectMenuBuilder()
    .setCustomId(`${PANEL_PREFIX}add_users`)
    .setPlaceholder('Select users to add')
    .setMinValues(1)
    .setMaxValues(25);
  const removeUsers = new UserSelectMenuBuilder()
    .setCustomId(`${PANEL_PREFIX}remove_users`)
    .setPlaceholder('Select users to remove')
    .setMinValues(1)
    .setMaxValues(25);
  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(`${PANEL_PREFIX}set_channel`)
    .setPlaceholder('Select a channel')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(1)
    .setMaxValues(1);
  const eventSelect = new StringSelectMenuBuilder()
    .setCustomId(`${PANEL_PREFIX}set_event`)
    .setPlaceholder('Select events to log')
    .addOptions(
      { label: 'Added only', description: 'Log reaction additions only', value: 'add' },
      { label: 'Removed only', description: 'Log reaction removals only', value: 'remove' },
      { label: 'Added and removed', description: 'Log both reaction events', value: 'both' }
    );
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PANEL_PREFIX}enable`).setLabel('Enable').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${PANEL_PREFIX}disable`).setLabel('Disable').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${PANEL_PREFIX}clear`).setLabel('Clear').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${PANEL_PREFIX}all_channels`).setLabel('All Channels').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${PANEL_PREFIX}refresh`).setLabel('Refresh').setStyle(ButtonStyle.Primary)
  );
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(addUsers), new ActionRowBuilder().addComponents(removeUsers), new ActionRowBuilder().addComponents(channelSelect), new ActionRowBuilder().addComponents(eventSelect), controls] };
}

async function execute(message, _args, { client, BOT_OWNERS = [] } = {}) {
  if (!isAllowed(message, BOT_OWNERS)) {
    return;
  }
  await message.channel.send(buildPanel(message.guild, client));
}

async function handleInteraction(interaction, { client, BOT_OWNERS = [] } = {}) {
  if (!interaction.customId?.startsWith(PANEL_PREFIX)) return false;
  if (!interaction.guild || !isAllowed(interaction, BOT_OWNERS)) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'This panel is restricted to server owners and administrators.', ephemeral: true }).catch(() => {});
    }
    return true;
  }

  const id = interaction.customId.slice(PANEL_PREFIX.length);
  const settings = getGuildSettings(interaction.guild.id);

  if (interaction.isUserSelectMenu()) {
    const selectedIds = interaction.values.map(normalizeId).filter(Boolean);
    if (id === 'add_users') {
      updateGuildSettings(interaction.guild.id, {
        enabled: true,
        recipientIds: [...new Set([...settings.recipientIds, ...selectedIds])]
      });
    } else if (id === 'remove_users') {
      const removeSet = new Set(selectedIds);
      updateGuildSettings(interaction.guild.id, {
        recipientIds: settings.recipientIds.filter(recipientId => !removeSet.has(recipientId))
      });
    }
    await interaction.update(buildPanel(interaction.guild, client));
    return true;
  }

  if (interaction.isChannelSelectMenu() && id === 'set_channel') {
    updateGuildSettings(interaction.guild.id, { channelId: interaction.values[0] || null });
    await interaction.update(buildPanel(interaction.guild, client));
    return true;
  }

  if (interaction.isStringSelectMenu() && id === 'set_event') {
    updateGuildSettings(interaction.guild.id, { eventMode: interaction.values[0] || 'both' });
    await interaction.update(buildPanel(interaction.guild, client));
    return true;
  }

  if (!interaction.isButton()) return true;
  if (id === 'enable') updateGuildSettings(interaction.guild.id, { enabled: true });
  if (id === 'disable') updateGuildSettings(interaction.guild.id, { enabled: false });
  if (id === 'clear') updateGuildSettings(interaction.guild.id, { recipientIds: [] });
  if (id === 'all_channels') updateGuildSettings(interaction.guild.id, { channelId: null });
  await interaction.update(buildPanel(interaction.guild, client));
  return true;
}

module.exports = { name, aliases, execute, handleInteraction, buildPanel };
