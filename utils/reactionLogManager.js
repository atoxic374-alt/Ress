const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');

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

function getGuildSettings(guildId) {
  const config = readConfig();
  const current = config.guilds[guildId] || {};
  return {
    enabled: current.enabled !== false,
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
  const color = isAdd ? '#57F287' : '#ED4245';
  const count = Number.isFinite(reaction.count) ? reaction.count : null;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`Reaction Log • ${actionText}`)
    .setDescription(`A reaction was **${isAdd ? 'added to' : 'removed from'}** a message.`)
    .addFields(
      { name: 'User', value: `<@${user.id}>\n\`${user.tag || user.username || user.id}\``, inline: true },
      { name: 'Reaction', value: emojiText(reaction.emoji), inline: true },
      { name: 'Current Count', value: count === null ? 'Unavailable' : `\`${count}\``, inline: true },
      { name: 'Message Author', value: messageAuthor ? `<@${messageAuthor.id}>\n\`${messageAuthor.tag || messageAuthor.username || messageAuthor.id}\`` : 'Unavailable', inline: true },
      { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
      { name: 'Message ID', value: `\`${message.id}\``, inline: true },
      { name: 'Message', value: `>>> ${truncate(message.content)}`, inline: false },
      { name: 'Link', value: `[Open message](${messageUrl})`, inline: false }
    )
    .setFooter({ text: `Reaction Log • ${guild.name}` })
    .setTimestamp(new Date());

  if (messageAuthor?.displayAvatarURL) {
    embed.setThumbnail(messageAuthor.displayAvatarURL({ size: 128 }));
  }
  return embed;
}

async function dispatchReactionLog({ reaction, user, action }) {
  const guild = reaction?.message?.guild;
  if (!guild || !user || user.bot) return { sent: 0, skipped: true };
  const settings = getGuildSettings(guild.id);
  if (!settings.enabled || settings.recipientIds.length === 0) return { sent: 0, skipped: true };

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
  normalizeId
};
