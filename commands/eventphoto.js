const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
  MessageFlags
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const name = 'eventphoto';
const aliases = ['eventimages', 'eventpic', 'rev'];
const dataPath = path.join(__dirname, '..', 'data', 'eventPhotoSystem.json');
const backupPath = `${dataPath}.bak`;
const lineImageDir = path.join(__dirname, '..', 'data', 'eventPhotoLines');
const runtime = { clients: new WeakSet(), handledInteractions: new WeakSet(), autoLocks: new Set(), voteLocks: new Map(), repostLocks: new Map(), lineUploadWaiters: new Map() };

function readData() {
  for (const filePath of [dataPath, backupPath]) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!data || typeof data !== 'object') throw new Error('invalid-data-root');
      if (!data.guilds || typeof data.guilds !== 'object' || Array.isArray(data.guilds)) data.guilds = {};
      if (filePath === backupPath) {
        try { fs.copyFileSync(backupPath, dataPath); } catch (error) { console.error(`eventphoto backup restore failed: ${error.message}`); }
      }
      return data;
    } catch (error) {
      if (filePath === dataPath && error.code !== 'ENOENT') console.error(`eventphoto data read failed (${error.message}); trying backup`);
    }
  }
  return { version: 1, guilds: {} };
}

function writeData(data) {
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  const temp = `${dataPath}.tmp`;
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  fs.writeFileSync(temp, serialized, { encoding: 'utf8', mode: 0o600 });
  const descriptor = fs.openSync(temp, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  if (fs.existsSync(dataPath)) fs.copyFileSync(dataPath, backupPath);
  fs.renameSync(temp, dataPath);
  fs.chmodSync(dataPath, 0o600);
  if (fs.existsSync(backupPath)) fs.chmodSync(backupPath, 0o600);
}

function lineImageFilePath(relativePath) {
  if (!relativePath || typeof relativePath !== 'string') return null;
  const root = path.resolve(lineImageDir);
  const resolved = path.resolve(path.join(path.dirname(lineImageDir), relativePath));
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

function lineAttachment(settings) {
  const localPath = lineImageFilePath(settings?.lineImagePath);
  if (localPath && fs.existsSync(localPath)) return { attachment: localPath, name: 'eventphoto-line.png' };
  if (settings?.lineImageUrl) return { attachment: settings.lineImageUrl, name: 'eventphoto-line.png' };
  return null;
}

async function saveLineImage(url, guildId, originalName = '') {
  const parsed = new URL(url);
  if (!['discordapp.com', 'discordapp.net'].some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) throw new Error('unsupported-line-image-host');
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`line-image-download-${response.status}`);
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('image/')) throw new Error('line-image-not-image');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) throw new Error('line-image-size-invalid');
  const extension = String(originalName).match(/\.(png|jpe?g|gif|webp|bmp)$/i)?.[1]?.toLowerCase() || 'png';
  const relativePath = path.join('eventPhotoLines', `${guildId}.${extension}`);
  fs.mkdirSync(lineImageDir, { recursive: true });
  const target = lineImageFilePath(relativePath);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, buffer, { mode: 0o600 });
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
  return relativePath;
}

function getGuild(data, guildId) {
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = {
      settings: { channelId: null, emoji: '✅', lineImageUrl: null, lineImagePath: null, managerIds: [] },
      posts: {}
    };
  }
  const guild = data.guilds[guildId];
  if (!guild.settings || typeof guild.settings !== 'object') guild.settings = { channelId: null, emoji: '✅', lineImageUrl: null, lineImagePath: null, managerIds: [] };
  if (!Object.prototype.hasOwnProperty.call(guild.settings, 'channelId')) guild.settings.channelId = null;
  if (!Object.prototype.hasOwnProperty.call(guild.settings, 'emoji')) guild.settings.emoji = '✅';
  if (!Object.prototype.hasOwnProperty.call(guild.settings, 'lineImageUrl')) guild.settings.lineImageUrl = null;
  if (!Object.prototype.hasOwnProperty.call(guild.settings, 'lineImagePath')) guild.settings.lineImagePath = null;
  guild.settings.managerIds = Array.isArray(guild.settings.managerIds)
    ? [...new Set(guild.settings.managerIds.map(String).filter(id => /^\d{16,20}$/.test(id)))]
    : [];
  if (!guild.posts || typeof guild.posts !== 'object' || Array.isArray(guild.posts)) guild.posts = {};
  return guild;
}

function isOwner(member) {
  const owners = Array.isArray(global.BOT_OWNERS) ? global.BOT_OWNERS : [];
  return Boolean(member && (member.id === member.guild?.ownerId || owners.includes(member.id)));
}

function isManager(member, guild) {
  return isOwner(member) || guild.settings.managerIds.includes(member?.id);
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

async function highestReactionCount(message) {
  const hasReactionCache = Boolean(message?.reactions?.cache);
  const freshMessage = message?.partial || !hasReactionCache
    ? await message.fetch().catch(() => message)
    : message;
  const reactions = freshMessage?.reactions?.cache ? [...freshMessage.reactions.cache.values()] : [];
  return Math.max(0, ...reactions.map(reaction => Number(reaction.count) || 0));
}

function permissionsOk(guild, channel) {
  const me = guild?.members?.me;
  const permissions = me && channel?.permissionsFor?.(me);
  return Boolean(
    permissions?.has(PermissionsBitField.Flags.ViewChannel) &&
    permissions?.has(PermissionsBitField.Flags.ReadMessageHistory) &&
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

function nextSequence(guild, channelId) {
  return Object.values(guild.posts)
    .filter(post => post.channelId === channelId)
    .reduce((max, post) => Math.max(max, Number(post.sequence) || 0), 0) + 1;
}

async function repost(message, initialCount = 0) {
  const images = imageAttachments(message);
  if (!message.guild || !images.length || !permissionsOk(message.guild, message.channel)) return false;
  const before = readData();
  const beforeGuild = getGuild(before, message.guild.id);
  if (beforeGuild.settings.channelId !== message.channel.id) return { success: false, reason: 'channel-not-enabled', separatorSent: false };
  const mentionedOwner = message.mentions?.users?.find?.(user => !user.bot);
  const ownerId = mentionedOwner?.id || message.author.id;
  const sequence = nextSequence(beforeGuild, message.channel.id);
  const files = images.map((attachment, index) => ({
    attachment: attachment.url,
    name: String(attachment.name || `image-${index + 1}.png`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)
  }));
  try {
    const sent = await message.channel.send({ content: `${sequence} - <@${ownerId}>`, allowedMentions: { users: [ownerId] }, files, components: components(message.guild.id, 'pending', beforeGuild.settings.emoji, initialCount) });
    if (!sent?.id || sent.attachments.size < files.length) {
      await sent?.delete?.().catch(() => {});
      return { success: false, reason: 'send-verification-failed', separatorSent: false };
    }
    const count = Math.max(0, Number(initialCount) || 0);
    const data = readData();
    const guild = getGuild(data, message.guild.id);
    guild.posts[sent.id] = {
      messageId: sent.id,
      channelId: message.channel.id,
      sourceMessageId: message.id,
      sourceAuthorId: message.author.id,
      sourceOwnerId: ownerId,
      sequence,
      baseCount: count,
      count,
      voters: [],
      manualAdditions: 0,
      manualRemovals: 0,
      managerAudit: [],
      createdAt: Date.now()
    };
    try {
      writeData(data);
    } catch (error) {
      await sent.delete().catch(() => {});
      console.error('eventphoto data save failed:', error.message);
      return { success: false, reason: 'data-save-failed', separatorSent: false };
    }
    try {
      await sent.edit({ components: components(message.guild.id, sent.id, guild.settings.emoji, count) });
    } catch (error) {
      delete guild.posts[sent.id];
      writeData(data);
      await sent.delete().catch(() => {});
      console.error('eventphoto component verification failed:', error.message);
      return { success: false, reason: 'component-verification-failed', separatorSent: false };
    }
    const line = lineAttachment(guild.settings);
    let separatorSent = !line;
    let separator = null;
    if (line) {
      separator = await message.channel.send({ files: [line] }).catch(error => {
        console.error('eventphoto line image failed:', error.message);
        return null;
      });
      separatorSent = Boolean(separator?.id && separator.attachments?.size);
      if (!separatorSent) {
        delete guild.posts[sent.id];
        writeData(data);
        await separator?.delete?.().catch(() => {});
        await sent.delete().catch(() => {});
        console.error('eventphoto separator verification failed');
        return { success: false, reason: 'separator-verification-failed', separatorSent: false };
      }
    }
    try {
      await message.delete();
    } catch (error) {
      delete guild.posts[sent.id];
      writeData(data);
      await separator?.delete?.().catch(() => {});
      await sent.delete().catch(() => {});
      console.error('eventphoto source deletion verification failed:', error.message);
      return { success: false, reason: 'source-delete-failed', separatorSent: false };
    }
    return { success: true, separatorSent };
  } catch (error) {
    console.error('eventphoto repost failed:', error.message);
    return { success: false, reason: error.message, separatorSent: false };
  }
}

async function enqueueRepost(message, initialCount = 0) {
  const key = `${message.guild.id}:${message.channel.id}`;
  const previous = runtime.repostLocks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => repost(message, initialCount));
  const tracked = current.catch(() => {});
  runtime.repostLocks.set(key, tracked);
  try {
    return await current;
  } finally {
    if (runtime.repostLocks.get(key) === tracked) runtime.repostLocks.delete(key);
  }
}

async function fetchAll(channel) {
  const result = [];
  const seen = new Set();
  let before;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
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

async function autoScan(guild, channelId, interaction = null) {
  const lock = `${guild.id}:${channelId}`;
  if (runtime.autoLocks.has(lock)) {
    if (interaction) await interaction.followUp({ content: '❌ يوجد Auto يعمل حاليًا في هذا الروم.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return { success: false, reason: 'already-running' };
  }
  runtime.autoLocks.add(lock);
  const stats = { scanned: 0, converted: 0, separators: 0, separatorFailures: 0, deleted: 0, deleteFailures: 0, failed: 0, skippedBots: 0 };
  const startSettings = getGuild(readData(), guild.id).settings;
  const startLineImageKey = startSettings.lineImagePath || startSettings.lineImageUrl || null;
  try {
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.() || !channel.messages?.fetch) throw new Error('invalid-channel');
    if (!permissionsOk(guild, channel)) throw new Error('missing-permissions');
    const messages = await fetchAll(channel);
    const eventData = readData();
    const eventGuild = getGuild(eventData, guild.id);
    for (const message of messages) {
      const liveSettings = getGuild(readData(), guild.id).settings;
      if (liveSettings.channelId !== channelId || (liveSettings.lineImagePath || liveSettings.lineImageUrl || null) !== startLineImageKey) {
        stats.reason = 'configuration-changed';
        break;
      }
      stats.scanned += 1;
      if (message.author?.bot || message.webhookId || message.applicationId || message.author?.id === guild.members.me?.id || eventGuild.posts[message.id]) {
        stats.skippedBots += 1;
        continue;
      }
      if (imageAttachments(message).length) {
        const result = await enqueueRepost(message, await highestReactionCount(message));
        if (result?.success) {
          stats.converted += 1;
          if (result.separatorSent) stats.separators += 1;
          else if (startLineImageKey) stats.separatorFailures += 1;
        } else {
          stats.failed += 1;
        }
      } else if (message.deletable) {
        const deleted = await message.delete().then(() => true).catch(() => false);
        if (deleted) stats.deleted += 1;
        else stats.deleteFailures += 1;
      } else {
        stats.deleteFailures += 1;
      }
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    stats.success = !stats.reason;
  } catch (error) {
    stats.success = false;
    stats.reason = error.message;
    if (interaction) await interaction.followUp({ content: `❌ Auto توقف قبل الإكمال. السبب: ${error.message === 'missing-permissions' ? 'صلاحيات البوت غير مكتملة.' : error.message === 'invalid-channel' ? 'الروم المحدد غير صالح.' : 'تعذر قراءة رسائل الروم.'}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    return stats;
  } finally {
    runtime.autoLocks.delete(lock);
  }
  if (interaction) {
    const lineSummary = startLineImageKey ? `\nSeparators: ${stats.separators} sent / ${stats.separatorFailures} failed` : '';
    const status = stats.reason === 'configuration-changed' ? '⚠️ Auto stopped because its channel setting changed.' : '✅ Auto completed.';
    await interaction.followUp({ content: `${status}\nScanned: ${stats.scanned}\nImages reposted: ${stats.converted}\nNon-images deleted: ${stats.deleted}\nFailures: ${stats.failed + stats.deleteFailures}${lineSummary}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  return stats;
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
      { name: 'Line Image', value: lineAttachment(state.settings) ? 'مفعلة' : 'غير محددة', inline: true },
      { name: 'Managers', value: state.settings.managerIds.length ? state.settings.managerIds.map(id => `<@${id}>`).join(', ').slice(0, 1024) : 'لا يوجد', inline: false },
      { name: 'Auto behavior', value: 'ينقل أعلى عدد رياكشن للصورة ويحذف غير الصور', inline: false },
      { name: 'Rev', value: 'استخدم `eventphoto rev @user` لمراجعة صور شخص محدد', inline: false }
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('eventphoto_setemoji').setLabel('setEmoji').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('eventphoto_live').setLabel('Live').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('eventphoto_auto').setLabel('Auto').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('eventphoto_disable').setLabel('Disable').setStyle(ButtonStyle.Danger)
  );
  const managerRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('eventphoto_add_manager').setLabel('Add Manager').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('eventphoto_remove_manager').setLabel('Remove Manager').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('eventphoto_set_line').setLabel('Set Line').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('eventphoto_clear_line').setLabel('Clear Line').setStyle(ButtonStyle.Danger)
  );
  return { embeds: [embed], components: [row, managerRow] };
}

function channelPicker(customId, placeholder) {
  return [new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1)
  )];
}

function userPicker(customId, placeholder) {
  return [new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(1).setMaxValues(10)
  )];
}

function extractUserId(input) {
  return String(input || '').match(/\d{16,20}/)?.[0] || null;
}

function isSnowflake(value) {
  return /^\d{16,20}$/.test(String(value || ''));
}

function recalculate(post) {
  post.voters = Array.isArray(post.voters)
    ? [...new Set(post.voters.map(String).filter(id => /^\d{16,20}$/.test(id)))]
    : [];
  post.managerAudit = Array.isArray(post.managerAudit) ? post.managerAudit.filter(item => item && typeof item === 'object') : [];
  post.baseCount = Math.max(0, Number(post.baseCount) || 0);
  post.manualAdditions = Math.max(0, Number(post.manualAdditions) || 0);
  post.manualRemovals = Math.max(0, Number(post.manualRemovals) || 0);
  post.count = Math.max(0, post.baseCount + (post.voters || []).length + post.manualAdditions - post.manualRemovals);
}

async function findPostsForUser(discordGuild, data, guild, userId) {
  const matches = [];
  let changed = false;
  for (const post of Object.values(guild.posts)) {
    if (post.sourceOwnerId === userId) {
      matches.push(post);
      continue;
    }
    if (post.sourceOwnerId) continue;
    const channel = discordGuild.channels.cache.get(post.channelId) || await discordGuild.channels.fetch(post.channelId).catch(() => null);
    const source = channel ? await channel.messages.fetch(post.sourceMessageId).catch(() => null) : null;
    if (source?.author?.id) {
      post.sourceAuthorId = source.author.id;
      post.sourceOwnerId = source.mentions?.users?.find?.(user => !user.bot)?.id || source.author.id;
      changed = true;
      if (post.sourceOwnerId === userId) matches.push(post);
    }
  }
  if (changed) {
    const latest = readData();
    const latestGuild = getGuild(latest, discordGuild.id);
    for (const post of Object.values(guild.posts)) {
      const latestPost = latestGuild.posts[post.messageId];
      if (latestPost && !latestPost.sourceOwnerId && post.sourceOwnerId) latestPost.sourceOwnerId = post.sourceOwnerId;
      if (latestPost && !latestPost.sourceAuthorId && post.sourceAuthorId) latestPost.sourceAuthorId = post.sourceAuthorId;
    }
    writeData(latest);
  }
  return matches.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function reviewEmbed(post, page = 0) {
  const voters = Array.isArray(post.voters) ? post.voters : [];
  const audit = Array.isArray(post.managerAudit) ? post.managerAudit.slice(-5) : [];
  const pageSize = 8;
  const pages = Math.max(1, Math.ceil(voters.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const pageVoters = voters.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const voterText = pageVoters.length ? pageVoters.map((id, i) => `${safePage * pageSize + i + 1}. <@${id}> (\`${id}\`)`).join('\n') : 'لا يوجد مصوتون حاليًا.';
  recalculate(post);
  return new EmbedBuilder()
    .setTitle('Rev • Voter Review')
    .setDescription(`**Post:** ${post.messageId}\n**Channel:** <#${post.channelId}>\n**Page:** ${safePage + 1}/${pages}`)
    .addFields(
      { name: 'Current Count', value: `**${post.count}**`, inline: true },
      { name: 'Real Voters', value: `**${voters.length}**`, inline: true },
      { name: 'Manual + / -', value: `**+${post.manualAdditions || 0} / -${post.manualRemovals || 0}**`, inline: true },
      { name: `Voters ${safePage * pageSize + 1}-${Math.min((safePage + 1) * pageSize, voters.length)}`, value: voterText, inline: false },
      { name: 'Recent Manager Changes', value: audit.length ? audit.map(item => `${item.action === 'add' ? '+' : '-'}${item.amount || 1} by <@${item.by}>`).join('\n') : 'لا توجد تعديلات يدوية.' , inline: false }
    );
}

function reviewComponents(postId, page, totalVoters) {
  const pages = Math.max(1, Math.ceil((totalVoters || 0) / 8));
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`eventphoto_rev_add:${postId}:${page}`).setLabel('+ Votes').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`eventphoto_rev_remove:${postId}:${page}`).setLabel('- Votes').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`eventphoto_rev_refresh:${postId}:${page}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`eventphoto_rev_page:${postId}:${Math.max(0, page - 1)}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
      new ButtonBuilder().setCustomId(`eventphoto_rev_page:${postId}:${Math.min(pages - 1, page + 1)}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1)
    )
  ];
}

async function execute(message, args, { client }) {
  if (!message.guild) return message.reply('❌ هذا الأمر يعمل داخل السيرفر فقط.');
  const panelData = readData();
  const panelGuild = getGuild(panelData, message.guild.id);
  const wantsRev = (args[0] || '').toLowerCase() === 'rev' || Boolean(extractUserId(args[0]) && args.length === 1);
  if (wantsRev ? !isManager(message.member, panelGuild) : !isOwner(message.member)) return message.reply('❌ هذا الأمر متاح للأونر أو مسؤول Event Photos عند استخدام Rev.');
  initialize(client);
  if (wantsRev) {
    const targetId = extractUserId((args[0] || '').toLowerCase() === 'rev' ? args.slice(1).join(' ') : args.join(' '));
    if (!targetId) return message.reply('❌ استخدم: `eventphoto rev @user` أو `eventphoto rev userID`');
    const posts = await findPostsForUser(message.guild, panelData, panelGuild, targetId);
    if (!posts.length) return message.reply('❌ لم يتم العثور على صورة محفوظة لهذا الشخص.');
    if (posts.length === 1) {
      const post = posts[0];
      return message.reply({ embeds: [reviewEmbed(post, 0)], components: reviewComponents(post.messageId, 0, post.voters?.length || 0) });
    }
    const options = posts.slice(0, 25).map(post => ({ label: `Post ${post.messageId.slice(-8)} | ${post.count || 0} votes`.slice(0, 100), description: `Voters: ${(post.voters || []).length}`.slice(0, 100), value: post.messageId }));
    const menu = new StringSelectMenuBuilder().setCustomId(`eventphoto_rev_select:${targetId}`).setPlaceholder('Select an image to review').addOptions(options);
    return message.reply({ content: `تم العثور على ${posts.length} صور. اختر الصورة:`, components: [new ActionRowBuilder().addComponents(menu)] });
  }
  if ((args[0] || '').toLowerCase() === 'off') {
    if (!isOwner(message.member)) return message.reply('❌ إيقاف النظام للأونر فقط.');
    const data = readData();
    const guild = getGuild(data, message.guild.id);
    guild.settings.channelId = null;
    writeData(data);
    return message.reply('✅ تم إيقاف Event Photos.');
  }
  return message.reply(settingsPanel(message.guild));
}

function initialize(client) {
  if (!client || typeof client !== 'object' || runtime.clients.has(client)) return;
  runtime.clients.add(client);
  client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;
    const data = readData();
    const guild = getGuild(data, message.guild.id);
    const waiterKey = `${message.guild.id}:${message.author.id}`;
    const waiter = runtime.lineUploadWaiters.get(waiterKey);
    if (waiter) {
      if (Date.now() > waiter.expiresAt) runtime.lineUploadWaiters.delete(waiterKey);
      else if (message.channel.id === waiter.channelId && isOwner(message.member)) {
        const line = imageAttachments(message)[0];
        if (line) {
          try {
            const previousPath = lineImageFilePath(guild.settings.lineImagePath);
            const localPath = await saveLineImage(line.url, message.guild.id, line.name);
            guild.settings.lineImageUrl = line.url;
            guild.settings.lineImagePath = localPath;
            writeData(data);
            if (previousPath && previousPath !== lineImageFilePath(localPath)) fs.unlinkSync(previousPath);
            runtime.lineUploadWaiters.delete(waiterKey);
            await message.delete().catch(() => {});
          } catch (error) {
            console.error('eventphoto line image save failed:', error.message);
            await message.reply('❌ تعذر حفظ صورة الفاصل. أرسل صورة من Discord مرة أخرى.').catch(() => {});
          }
          return;
        }
      }
    }
    if (guild.settings.channelId !== message.channel.id || !imageAttachments(message).length) return;
    await enqueueRepost(message);
  });
  client.on('interactionCreate', async interaction => {
    if (!interaction.guild || !interaction.customId?.startsWith('eventphoto_')) return;
    if (runtime.handledInteractions.has(interaction)) return;
    runtime.handledInteractions.add(interaction);
    try {
      const data = readData();
      const guild = getGuild(data, interaction.guild.id);
      if (interaction.customId.startsWith('eventphoto_vote:')) {
        const [, guildId, postId] = interaction.customId.split(':');
        if (guildId !== interaction.guild.id || !isSnowflake(postId)) return interaction.reply({ content: '❌ تصويت غير صالح.', flags: MessageFlags.Ephemeral });
        try { await interaction.deferUpdate(); } catch (error) {
          console.error('eventphoto vote acknowledgement failed:', error.message);
          return;
        }
        const lockKey = `${guildId}:${postId}`;
        const previous = runtime.voteLocks.get(lockKey) || Promise.resolve();
        const current = previous.catch(() => {}).then(async () => {
          const fresh = readData();
          const freshGuild = getGuild(fresh, interaction.guild.id);
          const post = freshGuild.posts[postId];
          if (!post) return interaction.editReply({ content: '❌ المنشور غير موجود.', components: [] }).catch(() => {});
          const voters = new Set(Array.isArray(post.voters) ? post.voters : []);
          if (voters.has(interaction.user.id)) voters.delete(interaction.user.id);
          else voters.add(interaction.user.id);
          post.voters = [...voters];
          recalculate(post);
          try {
            writeData(fresh);
            await interaction.editReply({ components: components(interaction.guild.id, postId, freshGuild.settings.emoji, post.count) });
          } catch (error) {
            console.error('eventphoto vote update failed:', error.message);
            await interaction.editReply({ content: '❌ تعذر حفظ التصويت، حاول مرة أخرى.' }).catch(() => {});
          }
        });
        const tracked = current.catch(() => {});
        runtime.voteLocks.set(lockKey, tracked);
        await current.catch(error => console.error('eventphoto vote failed:', error.message));
        if (runtime.voteLocks.get(lockKey) === tracked) runtime.voteLocks.delete(lockKey);
        return;
      }
      if (interaction.customId.startsWith('eventphoto_rev_select:')) {
        if (!isManager(interaction.member, guild)) return interaction.reply({ content: '❌ لا تملك الصلاحية.', flags: MessageFlags.Ephemeral });
        const post = guild.posts[interaction.values[0]];
        if (!post) return interaction.update({ content: '❌ المنشور غير موجود.', components: [] });
        return interaction.update({ content: null, embeds: [reviewEmbed(post, 0)], components: reviewComponents(post.messageId, 0, post.voters?.length || 0) });
      }
      if (interaction.customId.startsWith('eventphoto_rev_page:') || interaction.customId.startsWith('eventphoto_rev_refresh:')) {
        if (!isManager(interaction.member, guild)) return interaction.reply({ content: '❌ لا تملك الصلاحية.', flags: MessageFlags.Ephemeral });
        const [, postId, rawPage] = interaction.customId.split(':');
        if (!isSnowflake(postId) || !Number.isInteger(Number(rawPage)) || Number(rawPage) < 0) return interaction.reply({ content: '❌ Review action is invalid.', flags: MessageFlags.Ephemeral });
        const post = guild.posts[postId];
        if (!post) return interaction.update({ content: '❌ المنشور غير موجود.', embeds: [], components: [] });
        const page = Number(rawPage) || 0;
        return interaction.update({ embeds: [reviewEmbed(post, page)], components: reviewComponents(post.messageId, page, post.voters?.length || 0) });
      }
      if (interaction.customId.startsWith('eventphoto_rev_add:') || interaction.customId.startsWith('eventphoto_rev_remove:')) {
        if (!isManager(interaction.member, guild)) return interaction.reply({ content: '❌ لا تملك الصلاحية.', flags: MessageFlags.Ephemeral });
        const [, , postId, rawPage] = interaction.customId.split(':');
        if (!isSnowflake(postId) || !Number.isInteger(Number(rawPage)) || Number(rawPage) < 0) return interaction.reply({ content: '❌ Review action is invalid.', flags: MessageFlags.Ephemeral });
        const action = interaction.customId.startsWith('eventphoto_rev_add:') ? 'add' : 'remove';
        const modal = new ModalBuilder().setCustomId(`eventphoto_rev_amount:${action}:${postId}:${rawPage}`).setTitle(action === 'add' ? 'Add Votes' : 'Remove Votes');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('amount').setLabel('Vote Amount').setStyle(TextInputStyle.Short).setRequired(true).setValue('1').setMaxLength(8)
        ));
        return interaction.showModal(modal);
      }
      if (interaction.customId.startsWith('eventphoto_rev_amount:')) {
        if (!isManager(interaction.member, guild)) return interaction.reply({ content: '❌ لا تملك الصلاحية.', flags: MessageFlags.Ephemeral });
        const [, action, postId, rawPage] = interaction.customId.split(':');
        if (!['add', 'remove'].includes(action) || !isSnowflake(postId) || !Number.isInteger(Number(rawPage)) || Number(rawPage) < 0) return interaction.reply({ content: '❌ Review action is invalid.', flags: MessageFlags.Ephemeral });
        const amount = Number(interaction.fields.getTextInputValue('amount'));
        if (!Number.isInteger(amount) || amount < 1 || amount > 100000) return interaction.reply({ content: '❌ اكتب رقمًا صحيحًا بين 1 و100000.', flags: MessageFlags.Ephemeral });
        const fresh = readData();
        const freshGuild = getGuild(fresh, interaction.guild.id);
        const post = freshGuild.posts[postId];
        if (!post) return interaction.update({ content: '❌ المنشور غير موجود.', embeds: [], components: [] });
        post.managerAudit = Array.isArray(post.managerAudit) ? post.managerAudit : [];
        if (action === 'add') post.manualAdditions = (Number(post.manualAdditions) || 0) + amount;
        else post.manualRemovals = (Number(post.manualRemovals) || 0) + amount;
        post.managerAudit.push({ action, amount, by: interaction.user.id, at: Date.now() });
        recalculate(post);
        writeData(fresh);
        const page = Number(rawPage) || 0;
        return interaction.reply({ content: `✅ تم ${action === 'add' ? 'إضافة' : 'إزالة'} **${amount}** من العداد.`, embeds: [reviewEmbed(post, page)], components: reviewComponents(post.messageId, page, post.voters?.length || 0), flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'eventphoto_add_manager' || interaction.customId === 'eventphoto_remove_manager') {
        if (!isOwner(interaction.member)) return interaction.reply({ content: '❌ إضافة وإزالة المسؤولين للأونر فقط.', flags: MessageFlags.Ephemeral });
        const add = interaction.customId === 'eventphoto_add_manager';
        return interaction.reply({ content: add ? 'حدد المسؤولين لإضافتهم:' : 'حدد المسؤولين لإزالتهم:', components: userPicker(add ? 'eventphoto_add_manager_select' : 'eventphoto_remove_manager_select', 'Select Users'), flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'eventphoto_add_manager_select' || interaction.customId === 'eventphoto_remove_manager_select') {
        if (!isOwner(interaction.member)) return interaction.reply({ content: '❌ للأونر فقط.', flags: MessageFlags.Ephemeral });
        const add = interaction.customId === 'eventphoto_add_manager_select';
        const ids = new Set(guild.settings.managerIds);
        for (const id of interaction.values) add ? ids.add(id) : ids.delete(id);
        guild.settings.managerIds = [...ids];
        writeData(data);
        return interaction.reply({ content: add ? `✅ تمت إضافة ${interaction.values.length} مسؤول.` : `✅ تمت إزالة ${interaction.values.length} مسؤول.`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'eventphoto_set_line') {
        if (!isOwner(interaction.member)) return interaction.reply({ content: '❌ إعداد صورة الفاصل للأونر فقط.', flags: MessageFlags.Ephemeral });
        const waiterKey = `${interaction.guild.id}:${interaction.user.id}`;
        const waiter = { channelId: interaction.channelId, expiresAt: Date.now() + 120000 };
        runtime.lineUploadWaiters.set(waiterKey, waiter);
        const timer = setTimeout(() => {
          if (runtime.lineUploadWaiters.get(waiterKey) === waiter) runtime.lineUploadWaiters.delete(waiterKey);
        }, 120000);
        timer.unref?.();
        return interaction.reply({ content: 'أرسل الآن صورة الفاصل كمرفق في نفس الروم خلال دقيقتين. سيتم حفظها ولن تظهر كتصويت.', flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'eventphoto_clear_line') {
        if (!isOwner(interaction.member)) return interaction.reply({ content: '❌ إدارة صورة الفاصل للأونر فقط.', flags: MessageFlags.Ephemeral });
        const previousPath = lineImageFilePath(guild.settings.lineImagePath);
        guild.settings.lineImageUrl = null;
        guild.settings.lineImagePath = null;
        writeData(data);
        if (previousPath) fs.unlink(previousPath, () => {});
        return interaction.reply({ content: '✅ Line image cleared.', flags: MessageFlags.Ephemeral });
      }
      if (!isOwner(interaction.member)) return interaction.reply({ content: '❌ للأونرز فقط.', flags: MessageFlags.Ephemeral });
      if (interaction.customId === 'eventphoto_setemoji') {
        const modal = new ModalBuilder().setCustomId('eventphoto_setemoji_modal').setTitle('setEmoji');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('emoji').setLabel('Emoji').setStyle(TextInputStyle.Short).setRequired(true).setValue(guild.settings.emoji || '✅').setMaxLength(100)));
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
      if (interaction.customId === 'eventphoto_live') return interaction.reply({ content: 'حدد روم الصور الجديدة:', components: channelPicker('eventphoto_live_select', 'Select Live Channel'), flags: MessageFlags.Ephemeral });
      if (interaction.customId === 'eventphoto_live_select') {
        guild.settings.channelId = interaction.values[0];
        writeData(data);
        return interaction.reply({ content: `✅ تم تفعيل Live في <#${guild.settings.channelId}>.`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'eventphoto_auto') return interaction.reply({ content: 'حدد الروم. سيبدأ من أقدم رسالة، يعيد نشر الصور، ينقل أعلى رياكشن، ويحذف غير الصور.', components: channelPicker('eventphoto_auto_select', 'Select Auto Channel'), flags: MessageFlags.Ephemeral });
      if (interaction.customId === 'eventphoto_auto_select') {
        try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch (error) {
          console.error('eventphoto Auto acknowledgement failed:', error.message);
          return;
        }
        const channelId = interaction.values[0];
        const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased?.() || !channel.messages?.fetch) return interaction.editReply({ content: '❌ الروم المحدد غير صالح أو لا يدعم قراءة الرسائل.' });
        if (!permissionsOk(interaction.guild, channel)) return interaction.editReply({ content: '❌ صلاحيات البوت ناقصة. يحتاج View Channel وRead Message History وSend Messages وAttach Files وManage Messages.' });
        guild.settings.channelId = channelId;
        writeData(data);
        await interaction.editReply({ content: `✅ بدأ Auto في <#${channelId}>.` });
        setImmediate(() => autoScan(interaction.guild, channelId, interaction).catch(error => console.error('eventphoto Auto failed:', error)));
        return;
      }
      if (interaction.customId === 'eventphoto_disable') {
        guild.settings.channelId = null;
        writeData(data);
        return interaction.reply({ content: '✅ Event Photos disabled.', flags: MessageFlags.Ephemeral });
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
