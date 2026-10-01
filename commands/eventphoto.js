const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
  MessageFlags
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const name = 'eventphoto';
const aliases = ['eventimages', 'eventpic'];
const dataPath = path.join(__dirname, '..', 'data', 'eventPhotoSystem.json');
const runtime = { clients: new Set(), autoLocks: new Set(), voteLocks: new Map() };

function readData() {
  try {
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    if (!data.guilds || typeof data.guilds !== 'object') data.guilds = {};
    return data;
  } catch {
    return { version: 1, guilds: {} };
  }
}

function writeData(data) {
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  const temp = `${dataPath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, dataPath);
}

function getGuild(data, guildId) {
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = {
      settings: { channelId: null, emoji: '✅' },
      posts: {}
    };
  }
  const guild = data.guilds[guildId];
  if (!guild.settings || typeof guild.settings !== 'object') guild.settings = { channelId: null, emoji: '✅' };
  if (!Object.prototype.hasOwnProperty.call(guild.settings, 'channelId')) guild.settings.channelId = null;
  if (!Object.prototype.hasOwnProperty.call(guild.settings, 'emoji')) guild.settings.emoji = '✅';
  if (!guild.posts || typeof guild.posts !== 'object') guild.posts = {};
  return guild;
}

function isOwner(member) {
  const owners = Array.isArray(global.BOT_OWNERS) ? global.BOT_OWNERS : [];
  return Boolean(member && (member.id === member.guild?.ownerId || owners.includes(member.id)));
}

function isImageAttachment(attachment) {
  const type = String(attachment?.contentType || '').toLowerCase();
  const name = String(attachment?.name || '').toLowerCase();
  const url = String(attachment?.url || '').toLowerCase();
  return type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?$/i.test(name) || /\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?$/i.test(url);
}

function imageAttachments(message) {
  return [...(message?.attachments?.values?.() || [])].filter(isImageAttachment);
}

function highestReactionCount(message) {
  const reactions = message?.reactions?.cache ? [...message.reactions.cache.values()] : [];
  return Math.max(0, ...reactions.map(reaction => Number(reaction.count) || 0));
}

function permissionsOk(guild, channel) {
  const me = guild?.members?.me;
  const permissions = me && channel?.permissionsFor?.(me);
  return Boolean(
    permissions?.has(PermissionsBitField.Flags.ViewChannel) &&
    permissions?.has(PermissionsBitField.Flags.SendMessages) &&
    permissions?.has(PermissionsBitField.Flags.AttachFiles) &&
    permissions?.has(PermissionsBitField.Flags.ManageMessages)
  );
}

function components(guildId, postId, emoji, count) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`eventphoto_vote:${guildId}:${postId}`).setEmoji(emoji || '✅').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`eventphoto_count:${guildId}:${postId}`).setLabel(String(Math.max(0, Number(count) || 0))).setStyle(ButtonStyle.Secondary).setDisabled(true)
  )];
}

async function repost(message, initialCount = 0) {
  const images = imageAttachments(message);
  if (!message.guild || !images.length || !permissionsOk(message.guild, message.channel)) return false;
  const before = readData();
  const beforeGuild = getGuild(before, message.guild.id);
  const files = images.map((attachment, index) => ({
    attachment: attachment.url,
    name: String(attachment.name || `image-${index + 1}.png`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)
  }));
  try {
    const sent = await message.channel.send({ files, components: components(message.guild.id, 'pending', beforeGuild.settings.emoji, initialCount) });
    if (!sent?.id || sent.attachments.size < files.length) {
      await sent?.delete?.().catch(() => {});
      return false;
    }
    const count = Math.max(0, Number(initialCount) || 0);
    const data = readData();
    const guild = getGuild(data, message.guild.id);
    guild.posts[sent.id] = {
      messageId: sent.id,
      channelId: message.channel.id,
      sourceMessageId: message.id,
      baseCount: count,
      count,
      voters: [],
      createdAt: Date.now()
    };
    writeData(data);
    try {
      await sent.edit({ components: components(message.guild.id, sent.id, guild.settings.emoji, count) });
    } catch (error) {
      delete guild.posts[sent.id];
      writeData(data);
      await sent.delete().catch(() => {});
      console.error('eventphoto component verification failed:', error.message);
      return false;
    }
    await message.delete();
    return true;
  } catch (error) {
    console.error('eventphoto repost failed:', error.message);
    return false;
  }
}

async function fetchAll(channel) {
  const result = [];
  const seen = new Set();
  let before;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!batch || !batch.size) break;
    for (const message of batch.values()) {
      if (!seen.has(message.id)) {
        seen.add(message.id);
        result.push(message);
      }
    }
    const oldest = batch.last();
    if (!oldest?.id || batch.size < 100) break;
    before = oldest.id;
  }
  return result.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function autoScan(guild, channelId) {
  const lock = `${guild.id}:${channelId}`;
  if (runtime.autoLocks.has(lock)) return;
  runtime.autoLocks.add(lock);
  try {
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !permissionsOk(guild, channel)) return;
    const messages = await fetchAll(channel);
    for (const message of messages) {
      if (message.author?.bot) continue;
      if (imageAttachments(message).length) {
        await repost(message, highestReactionCount(message));
      } else if (message.deletable) {
        await message.delete().catch(() => {});
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } finally {
    runtime.autoLocks.delete(lock);
  }
}

function settingsPanel(guild) {
  const data = readData();
  const state = getGuild(data, guild.id);
  const embed = new EmbedBuilder()
    .setTitle('Event Photos')
    .setDescription('نظام مستقل لتحويل الصور إلى منشورات تصويت.\n\n**Live:** الصور الجديدة فقط\n**Auto:** فحص قديم من الأقدم للأحدث')
    .addFields(
      { name: 'Channel', value: state.settings.channelId ? `<#${state.settings.channelId}>` : 'غير محدد', inline: true },
      { name: 'setEmoji', value: state.settings.emoji || '✅', inline: true },
      { name: 'Auto behavior', value: 'ينقل أعلى عدد رياكشن للصورة ويحذف غير الصور', inline: false }
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('eventphoto_setemoji').setLabel('setEmoji').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('eventphoto_live').setLabel('Live').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('eventphoto_auto').setLabel('Auto').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('eventphoto_disable').setLabel('Disable').setStyle(ButtonStyle.Danger)
  );
  return { embeds: [embed], components: [row] };
}

function channelPicker(customId, placeholder) {
  return [new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1)
  )];
}

async function execute(message, args, { client }) {
  if (!message.guild) return message.reply('❌ هذا الأمر يعمل داخل السيرفر فقط.');
  if (!isOwner(message.member)) return message.reply('❌ هذا الأمر للأونرز فقط.');
  initialize(client);
  if ((args[0] || '').toLowerCase() === 'off') {
    const data = readData();
    const guild = getGuild(data, message.guild.id);
    guild.settings.channelId = null;
    writeData(data);
    return message.reply('✅ تم إيقاف Event Photos.');
  }
  return message.reply(settingsPanel(message.guild));
}

function initialize(client) {
  const key = client.user?.id || 'client';
  if (runtime.clients.has(key)) return;
  runtime.clients.add(key);
  client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;
    const data = readData();
    const guild = getGuild(data, message.guild.id);
    if (guild.settings.channelId !== message.channel.id || !imageAttachments(message).length) return;
    await repost(message);
  });
  client.on('interactionCreate', async interaction => {
    if (!interaction.guild || !interaction.customId?.startsWith('eventphoto_')) return;
    try {
      const data = readData();
      const guild = getGuild(data, interaction.guild.id);
      if (interaction.customId.startsWith('eventphoto_vote:')) {
        const [, guildId, postId] = interaction.customId.split(':');
        if (guildId !== interaction.guild.id) return interaction.reply({ content: '❌ تصويت غير صالح.', flags: MessageFlags.Ephemeral });
        const lockKey = `${guildId}:${postId}`;
        const previous = runtime.voteLocks.get(lockKey) || Promise.resolve();
        const current = previous.catch(() => {}).then(async () => {
          const fresh = readData();
          const freshGuild = getGuild(fresh, interaction.guild.id);
          const post = freshGuild.posts[postId];
          if (!post) return interaction.reply({ content: '❌ المنشور غير موجود.', flags: MessageFlags.Ephemeral });
          const voters = new Set(Array.isArray(post.voters) ? post.voters : []);
          if (voters.has(interaction.user.id)) voters.delete(interaction.user.id);
          else voters.add(interaction.user.id);
          post.voters = [...voters];
          post.baseCount = Math.max(0, Number(post.baseCount) || 0);
          post.count = post.baseCount + post.voters.length;
          writeData(fresh);
          await interaction.update({ components: components(interaction.guild.id, postId, freshGuild.settings.emoji, post.count) });
        });
        const tracked = current.catch(() => {});
        runtime.voteLocks.set(lockKey, tracked);
        await current.catch(error => console.error('eventphoto vote failed:', error.message));
        if (runtime.voteLocks.get(lockKey) === tracked) runtime.voteLocks.delete(lockKey);
        return;
      }
      if (!isOwner(interaction.member)) return interaction.reply({ content: '❌ للأونرز فقط.', flags: MessageFlags.Ephemeral });
      if (interaction.customId === 'eventphoto_setemoji') {
        const modal = new ModalBuilder().setCustomId('eventphoto_setemoji_modal').setTitle('setEmoji');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('emoji').setLabel('ضع الإيموجي').setStyle(TextInputStyle.Short).setRequired(true).setValue(guild.settings.emoji || '✅').setMaxLength(100)));
        return interaction.showModal(modal);
      }
      if (interaction.customId === 'eventphoto_setemoji_modal') {
        const emoji = interaction.fields.getTextInputValue('emoji').trim();
        if (!emoji) return interaction.reply({ content: '❌ الإيموجي مطلوب.', flags: MessageFlags.Ephemeral });
        try { new ButtonBuilder().setCustomId('eventphoto_test').setEmoji(emoji); } catch { return interaction.reply({ content: '❌ الإيموجي غير صالح.', flags: MessageFlags.Ephemeral }); }
        guild.settings.emoji = emoji;
        writeData(data);
        return interaction.reply({ content: `✅ تم حفظ setEmoji: ${emoji}`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'eventphoto_live') return interaction.reply({ content: 'حدد روم الصور الجديدة:', components: channelPicker('eventphoto_live_select', 'حدد روم Live'), flags: MessageFlags.Ephemeral });
      if (interaction.customId === 'eventphoto_live_select') {
        guild.settings.channelId = interaction.values[0];
        writeData(data);
        return interaction.reply({ content: `✅ تم تفعيل Live في <#${guild.settings.channelId}>.`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'eventphoto_auto') return interaction.reply({ content: 'حدد الروم. سيبدأ من أقدم رسالة، يعيد نشر الصور، ينقل أعلى رياكشن، ويحذف غير الصور.', components: channelPicker('eventphoto_auto_select', 'حدد روم Auto'), flags: MessageFlags.Ephemeral });
      if (interaction.customId === 'eventphoto_auto_select') {
        const channelId = interaction.values[0];
        guild.settings.channelId = channelId;
        writeData(data);
        await interaction.reply({ content: `✅ بدأ Auto في <#${channelId}>.`, flags: MessageFlags.Ephemeral });
        setImmediate(() => autoScan(interaction.guild, channelId).catch(error => console.error('eventphoto Auto failed:', error)));
        return;
      }
      if (interaction.customId === 'eventphoto_disable') {
        guild.settings.channelId = null;
        writeData(data);
        return interaction.reply({ content: '✅ تم إيقاف Live.', flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      console.error('eventphoto interaction failed:', error);
      if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: '❌ حدث خطأ غير متوقع.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });
}

function registerInteractionHandler(client) {
  initialize(client);
}

module.exports = { name, aliases, execute, registerInteractionHandler };
