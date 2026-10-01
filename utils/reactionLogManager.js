const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const colorManager = require('./colorManager');

const configPath = path.join(__dirname, '..', 'data', 'reactionLogConfig.json');
const DEFAULT_CONFIG = { version: 1, guilds: {} };

function readConfig() {
  try {
    if (!fs.existsSync(configPath)) return structuredClone(DEFAULT_CONFIG);
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      guilds: parsed?.guilds && typeof parsed.guilds === 'object' ? parsed.guilds : {}
    };
  } catch (error) {
    console.error('❌ تعذر قراءة إعدادات لوق الرياكشن:', error.message);
    return structuredClone(DEFAULT_CONFIG);
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(config, null, 2));
  fs.renameSync(tempPath, configPath);
}

function normalizeId(value) {
  const id = String(value || '').replace(/[<@!>]/g, '').trim();
  return /^\d{15,21}$/.test(id) ? id : null;
}

function normalizeChannelId(value) {
  const id = String(value || '').replace(/[<#>]/g, '').trim();
  return /^\d{15,21}$/.test(id) ? id : null;
}

function normalizeEventMode(value) {
  return ['add', 'remove', 'both'].includes(value) ? value : 'both';
}

function getGuildSettings(guildId) {
  const config = readConfig();
  const current = config.guilds[guildId] || {};
  return {
    enabled: current.enabled !== false,
    channelId: normalizeChannelId(current.channelId),
    eventMode: normalizeEventMode(current.eventMode),
    recipientIds: Array.isArray(current.recipientIds)
      ? [...new Set(current.recipientIds.map(normalizeId).filter(Boolean))]
      : []
  };
}

function updateGuildSettings(guildId, patch) {
  const config = readConfig();
  const current = getGuildSettings(guildId);
  const next = {
    ...current,
    ...patch,
    channelId: patch.channelId === undefined
      ? current.channelId
      : normalizeChannelId(patch.channelId),
    eventMode: patch.eventMode === undefined
      ? current.eventMode
      : normalizeEventMode(patch.eventMode),
    recipientIds: [...new Set((patch.recipientIds ?? current.recipientIds).map(normalizeId).filter(Boolean))]
  };
  config.guilds[guildId] = next;
  writeConfig(config);
  return next;
}

function emojiText(emoji) {
  if (!emoji) return 'Unknown';
  if (emoji.id) return `${emoji.name || 'custom'} (<:${emoji.name || 'emoji'}:${emoji.id}>)`;
  return emoji.name || emoji.toString?.() || 'Unknown';
}

function truncate(value, max = 900) {
  const text = String(value || '').trim();
  if (!text) return 'بدون محتوى';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function buildReactionLogEmbed({ reaction, user, action }) {
  const message = reaction.message;
  const guild = message.guild;
  const messageAuthor = message.author;
  const messageUrl = message.url || `https://discord.com/channels/${guild.id}/${message.channelId}/${message.id}`;
  const isAdd = action === 'add';
  const actionText = isAdd ? 'Reaction Added' : 'Reaction Removed';
  const actorLabel = isAdd ? 'Added By' : 'Removed By';
  const count = Number.isFinite(reaction.count) ? reaction.count : null;

  const embed = colorManager.createEmbed()
    .setTitle(`Reaction Log • ${actionText}`)
    .setDescription(`A reaction was **${isAdd ? 'added to' : 'removed from'}** a message.`)
    .addFields(
      { name: actorLabel, value: `<@${user.id}>\nID: \`${user.id}\`\n\`${user.tag || user.username || user.id}\``, inline: true },
      { name: 'Current Count', value: count === null ? 'Unavailable' : `\`${count}\``, inline: true },
      { name: 'Message Author', value: messageAuthor ? `<@${messageAuthor.id}>\n\`${messageAuthor.tag || messageAuthor.username || messageAuthor.id}\`` : 'Unavailable', inline: true },
      { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
      { name: 'Message ID', value: `\`${message.id}\``, inline: true },
      { name: 'Message', value: `>>> ${truncate(message.content)}`, inline: false },
      { name: 'Link', value: `[Open message](${messageUrl})`, inline: false },
      { name: 'Reaction', value: emojiText(reaction.emoji), inline: true }
    )
    .setFooter({ text: `Reaction Log • ${guild.name}` })
    .setTimestamp(new Date());

  const botAvatar = guild.client?.user?.displayAvatarURL?.({ dynamic: true, size: 256 });
  if (botAvatar) {
    embed.setThumbnail(botAvatar);
  }
  return embed;
}

async function dispatchReactionLog({ reaction, user, action }) {
  const guild = reaction?.message?.guild;
  if (!guild || !user || user.bot) return { sent: 0, skipped: true };
  const settings = getGuildSettings(guild.id);
  if (!settings.enabled || settings.recipientIds.length === 0) return { sent: 0, skipped: true };
  if (settings.eventMode !== 'both' && settings.eventMode !== action) {
    return { sent: 0, skipped: true };
  }
  if (settings.channelId && String(reaction.message.channelId) !== String(settings.channelId)) {
    return { sent: 0, skipped: true };
  }

  const embed = buildReactionLogEmbed({ reaction, user, action });
  let sent = 0;
  for (const recipientId of settings.recipientIds) {
    try {
      const recipient = await guild.client.users.fetch(recipientId);
      await recipient.send({ embeds: [embed], allowedMentions: { parse: [] } });
      sent += 1;
    } catch (error) {
      console.warn(`⚠️ تعذر إرسال لوق الرياكشن بالخاص إلى ${recipientId}: ${error.code || error.message}`);
    }
  }
  return { sent, skipped: false };
}

module.exports = {
  configPath,
  getGuildSettings,
  updateGuildSettings,
  dispatchReactionLog,
  normalizeId,
  normalizeChannelId,
  normalizeEventMode
};
