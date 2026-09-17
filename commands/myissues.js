const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');

const interactionRouter = require('../utils/interactionRouter.js');
const colorManager = require('../utils/colorManager.js');
const { allowedMentions, userMention, normalizeDiscordId } = require('../utils/mentions.js');

const { activeProblems, getProblemHistory } = require('./problem.js');

const fs = require('fs');
const path = require('path');

// Load problem configuration to access responsibleRoleIds.  This replicates
// the helper in problem.js to avoid circular dependencies.
function loadProblemConfig() {
  try {
    const configPath = path.join(__dirname, '..', 'data', 'problemConfig.json');
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(data);
      return {
        logsChannelId: typeof config.logsChannelId === 'string' ? config.logsChannelId : null,
        muteRoleId: typeof config.muteRoleId === 'string' ? config.muteRoleId : null,
        muteDuration: typeof config.muteDuration === 'number' ? config.muteDuration : 10 * 60 * 1000,
        responsibleRoleIds: Array.isArray(config.responsibleRoleIds) ? config.responsibleRoleIds : []
      };
    }
  } catch (err) {
    console.error('Failed to load problemConfig in myissues.js:', err);
  }
  return { logsChannelId: null, muteRoleId: null, muteDuration: 10 * 60 * 1000, responsibleRoleIds: [] };
}

function loadAdminRoles() {
  try {
    const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
    if (fs.existsSync(adminRolesPath)) {
      const data = fs.readFileSync(adminRolesPath, 'utf8');
      const adminRoles = JSON.parse(data);
      return Array.isArray(adminRoles) ? adminRoles : [];
    }
    return [];
  } catch (error) {
    console.error('Error reading adminRoles:', error);
    return [];
  }
}

// Session store for pagination
const sessionStores = new WeakMap();
function getSessionStore(client) {
  if (!sessionStores.has(client)) sessionStores.set(client, new Map());
  return sessionStores.get(client);
}

function userIsModerator(member, adminRoles, owners) {
  if (member.id === member.guild.ownerId) return true;
  if (Array.isArray(owners) && owners.includes(member.id)) return true;
  try {
    const cfg = loadProblemConfig();
    const responsible = cfg.responsibleRoleIds || [];
    if (responsible.some((roleId) => member.roles.cache.has(roleId))) return true;
  } catch (_) {}
  return adminRoles.some((r) => member.roles.cache.has(r));
}

const name = 'myissues';
const aliases = ['مشاكلي'];

function isProblemForGuild(problem, guildId) {
  return problem && (!problem.guildId || problem.guildId === guildId);
}

function addEntry(entries, entry) {
  const otherId = normalizeDiscordId(entry.otherId);
  if (!otherId) return;
  const moderatorId = normalizeDiscordId(entry.moderatorId);
  const status = entry.status === 'active' ? 'active' : 'ended';
  entries.push({
    ...entry,
    otherId,
    moderatorId,
    status,
    reason: typeof entry.reason === 'string' && entry.reason.trim() ? entry.reason.trim() : 'غير محدد'
  });
}

function mentionOrFallback(id, fallback = 'غير معروف') {
  return userMention(id) || fallback;
}

async function execute(message, args, context) {
  const { client } = context;
  const adminRoles = loadAdminRoles();
  const owners = context.BOT_OWNERS || [];
  let targetId;

  if (args.length > 0) {
    if (message.mentions.users.size > 0) {
      targetId = message.mentions.users.first().id;
    } else {
      targetId = normalizeDiscordId(args[0]);
    }
    if (!targetId) return message.reply({ content: '**الرجاء تحديد عضو صحيح.**', allowedMentions });
    if (targetId !== message.author.id && !userIsModerator(message.member, adminRoles, owners)) {
      return message.reply({ content: '**ليس لديك صلاحية عرض مشاكل الآخرين.**', allowedMentions });
    }
  } else {
    targetId = message.author.id;
  }

  const guild = message.guild;
  const entries = [];

  // Active problems have no status in some older records; normalize them to active.
  for (const [, prob] of activeProblems.entries()) {
    if (!isProblemForGuild(prob, guild.id)) continue;
    const firstId = normalizeDiscordId(prob.firstId);
    const secondId = normalizeDiscordId(prob.secondId);
    if (firstId !== targetId && secondId !== targetId) continue;
    const otherId = firstId === targetId ? secondId : firstId;
    addEntry(entries, {
      otherId,
      timestamp: prob.timestamp,
      endedAt: null,
      status: 'active',
      reason: prob.reason,
      moderatorId: prob.moderatorId
    });
  }

  for (const record of getProblemHistory(guild.id, targetId)) {
    const firstId = normalizeDiscordId(record.firstId);
    const secondId = normalizeDiscordId(record.secondId);
    const otherId = firstId === targetId ? secondId : firstId;
    addEntry(entries, {
      otherId,
      timestamp: record.timestamp,
      endedAt: record.endedAt,
      status: record.status,
      reason: record.reason,
      moderatorId: record.moderatorId
    });
  }

  // Prefer the current/most complete record when old history and active data overlap.
  const uniqueEntries = [...new Map(entries.map((entry) => [
    `${entry.otherId}:${entry.timestamp}:${entry.status}`,
    entry
  ])).values()].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  if (uniqueEntries.length === 0) {
    const content = targetId === message.author.id
      ? '**ليس لديك أي مشاكل مسجلة.**'
      : '**لا توجد مشاكل مسجلة لهذا العضو.**';
    return message.reply({ content, allowedMentions });
  }

  // Show one problem per page so every record has enough room for its fields.
  const pageSize = 1;
  const sessionStore = getSessionStore(client);
  sessionStore.set(message.author.id, {
    entries: uniqueEntries,
    page: 0,
    pageSize,
    targetId,
    messageId: null
  });

  const embed = buildPageEmbed(uniqueEntries, 0, pageSize, targetId, guild);
  const row = buildNavRow(0, Math.ceil(uniqueEntries.length / pageSize));
  const mentionUsers = [...new Set([
    targetId,
    ...uniqueEntries.flatMap((entry) => [entry.otherId, entry.moderatorId]).filter(Boolean)
  ])];
  const sent = await message.channel.send({
    embeds: [embed],
    components: [row],
    allowedMentions: { users: mentionUsers, roles: [], repliedUser: false }
  });
  sessionStore.get(message.author.id).messageId = sent.id;

  try {
    const filter = (i) => i.user.id === message.author.id;
    const collector = sent.createMessageComponentCollector({ filter, time: 5 * 60 * 1000 });
    collector.on('end', async () => {
      await sent.edit({ components: [] }).catch(() => {});
      getSessionStore(client).delete(message.author.id);
    });
  } catch (_) {}

  if (!client._myIssuesRouterRegistered) {
    const ownersList = context.BOT_OWNERS || [];
    interactionRouter.register('myissues_', async (interaction, client) => {
      await handleInteraction(interaction, { client, BOT_OWNERS: ownersList });
    });
    client._myIssuesRouterRegistered = true;
  }
}

function formatDate(value) {
  if (!value) return 'غير محدد';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'غير محدد';
  return date.toLocaleString('en-US', {
    timeZone: 'Asia/Riyadh',
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

function buildPageEmbed(entries, page, pageSize, targetId, guild) {
  const start = page * pageSize;
  const end = Math.min(entries.length, start + pageSize);
  const totalPages = Math.ceil(entries.length / pageSize);
  const targetMention = userMention(targetId) || 'العضو المحدد';
  const embed = colorManager.createEmbed()
    .setTitle('Problems')
    .setDescription(targetMention)
    .setTimestamp();
  const targetMember = guild?.members?.cache?.get(targetId);
  const targetAvatar = targetMember?.displayAvatarURL?.({ extension: 'png', size: 128 });
  if (targetAvatar) embed.setThumbnail(targetAvatar);

  for (let i = start; i < end; i++) {
    const entry = entries[i];
    const otherMention = mentionOrFallback(entry.otherId);
    const moderatorMention = mentionOrFallback(entry.moderatorId);
    const otherMember = guild?.members?.cache?.get(entry.otherId);
    const moderatorMember = entry.moderatorId ? guild?.members?.cache?.get(entry.moderatorId) : null;
    const otherLabel = otherMember?.displayName ? ` (${otherMember.displayName})` : '';
    const moderatorLabel = moderatorMember?.displayName ? ` (${moderatorMember.displayName})` : '';
    const status = entry.status === 'active' ? '🟢' : '⚪';

    embed.addFields(
      { name: 'الطرف الآخر : ', value: `${otherMention}${otherLabel}`, inline: false },
      { name: 'الحالة : ', value: status, inline: true },
      { name: 'المسؤول : ', value: `${moderatorMention}${moderatorLabel}`, inline: true },
      { name: 'السبب : ', value: entry.reason, inline: false },
      { name: 'وقت البداية : ', value: formatDate(entry.timestamp), inline: true },
      ...(entry.endedAt
        ? [{ name: 'وقت الإنهاء : ', value: formatDate(entry.endedAt), inline: true }]
        : [])
    );
  }

  embed.setFooter({ text: `All Problems : ${entries.length} | Page ${page + 1} of ${totalPages} - Use the buttons to navigate` });
  return embed;
}

function buildNavRow(page, totalPages) {
  const prev = new ButtonBuilder()
    .setCustomId('myissues_prev')
    .setLabel('Previous')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(page === 0);
  const next = new ButtonBuilder()
    .setCustomId('myissues_next')
    .setLabel('Next')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(page >= totalPages - 1);
  return new ActionRowBuilder().addComponents(prev, next);
}

async function handleInteraction(interaction, context) {
  const { client } = context;
  const id = interaction.customId;
  if (!id || !id.startsWith('myissues_') || !interaction.isButton()) return;
  const session = getSessionStore(client).get(interaction.user.id);
  if (!session) return;

  if (!interaction.replied && !interaction.deferred) {
    await interaction.deferUpdate().catch((error) => {
      if (error?.code !== 10062) console.error('Failed to defer myissues interaction:', error);
    });
    if (!interaction.deferred && !interaction.replied) return;
  }

  const totalPages = Math.ceil(session.entries.length / session.pageSize);
  if (id === 'myissues_prev' && session.page > 0) session.page -= 1;
  if (id === 'myissues_next' && session.page < totalPages - 1) session.page += 1;

  const embed = buildPageEmbed(session.entries, session.page, session.pageSize, session.targetId, interaction.guild);
  const row = buildNavRow(session.page, totalPages);
  const mentionUsers = [...new Set([
    session.targetId,
    ...session.entries.flatMap((entry) => [entry.otherId, entry.moderatorId]).filter(Boolean)
  ])];
  try {
    const msg = await interaction.channel.messages.fetch(session.messageId).catch(() => null);
    if (msg) {
      await msg.edit({
        embeds: [embed],
        components: [row],
        allowedMentions: { users: mentionUsers, roles: [], repliedUser: false }
      });
    }
  } catch (err) {
    console.error('Failed to edit myissues message:', err);
  }
}

module.exports = {
  name,
  aliases,
  execute,
  handleInteraction,
  buildPageEmbed,
  formatDate
};
