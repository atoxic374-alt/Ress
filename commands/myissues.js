const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');

const interactionRouter = require('../utils/interactionRouter.js');
const colorManager = require('../utils/colorManager.js');

const { activeProblems } = require('./problem.js');

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

// Load admin roles helper
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

// Check if member is moderator (owner/admin role)
function userIsModerator(member, adminRoles, owners) {
  if (member.id === member.guild.ownerId) return true;
  if (Array.isArray(owners) && owners.includes(member.id)) return true;
  // Check responsible roles from problemConfig
  try {
    const cfg = loadProblemConfig();
    const responsible = cfg.responsibleRoleIds || [];
    if (responsible.some((roleId) => member.roles.cache.has(roleId))) return true;
  } catch (_) {}
  return adminRoles.some((r) => member.roles.cache.has(r));
}

// Command name and aliases
const name = 'myissues';
// Arabic alias for the myissues command so users can type "مشاكلي"
const aliases = ['مشاكلي'];

async function execute(message, args, context) {
  const { client } = context;
  const adminRoles = loadAdminRoles();
  const owners = context.BOT_OWNERS || [];
  // Determine target: either specified or the caller
  let targetId;
  if (args.length > 0) {
    if (message.mentions.users.size > 0) {
      targetId = message.mentions.users.first().id;
    } else {
      targetId = args[0].replace(/[^\d]/g, '');
    }
    if (!targetId) {
      return message.reply('❌ **الرجاء تحديد معرف صحيح.**');
    }
    // If the target is not the caller, require moderator permissions
    if (targetId !== message.author.id && !userIsModerator(message.member, adminRoles, owners)) {
      return message.reply('❌ **ليس لديك صلاحية عرض مشاكل الآخرين.**');
    }
  } else {
    targetId = message.author.id;
  }
  const guild = message.guild;
  // Collect problems for target
  const entries = [];
  for (const [key, prob] of activeProblems.entries()) {
    if (prob.firstId === targetId || prob.secondId === targetId) {
      const otherId = prob.firstId === targetId ? prob.secondId : prob.firstId;
      const otherMember = guild.members.cache.get(otherId);
      const otherName = otherMember ? otherMember.displayName : otherId;
      const modName = guild.members.cache.get(prob.moderatorId)?.displayName || prob.moderatorId;
      entries.push({
        otherId,
        otherName,
        timestamp: prob.timestamp,
        moderatorId: prob.moderatorId,
        moderatorName: modName
      });
    }
  }
  if (entries.length === 0) {
    if (targetId === message.author.id) {
      return message.reply('⚠️ **ليس لديك أية مشاكل حالية.**');
    }
    return message.reply('⚠️ **لا توجد مشاكل مسجّلة لهذا العضو.**');
  }
  // Session store with pagination info
  const sessionStore = getSessionStore(client);
  // Each session keyed by user id
  const pageSize = 5;
  sessionStore.set(message.author.id, {
    entries,
    page: 0,
    pageSize,
    targetId,
    messageId: null
  });
  // Build initial page
  const embed = buildPageEmbed(entries, 0, pageSize, targetId);
  const row = buildNavRow(0, Math.ceil(entries.length / pageSize));
  const sent = await message.channel.send({ embeds: [embed], components: [row] });
  // Store message ID
  const session = sessionStore.get(message.author.id);
  session.messageId = sent.id;

  // Restrict interaction to the invoking user and auto-end pagination after a timeout
  try {
    const filter = (i) => i.user.id === message.author.id;
    const collector = sent.createMessageComponentCollector({ filter, time: 5 * 60 * 1000 });
    collector.on('end', async () => {
      try {
        // Remove navigation buttons to end interaction
        await sent.edit({ components: [] }).catch(() => {});
        // Clean up session for this user
        const store = getSessionStore(client);
        store.delete(message.author.id);
      } catch (_) {
        // ignore cleanup errors
      }
    });
  } catch (_) {
    // In case the collector cannot be created, continue without restrictions
  }
  // Register router
  if (!client._myIssuesRouterRegistered) {
    const ownersList = context.BOT_OWNERS || [];
    interactionRouter.register('myissues_', async (interaction, client) => {
      await handleInteraction(interaction, { client, BOT_OWNERS: ownersList });
    });
    client._myIssuesRouterRegistered = true;
  }
}

function buildPageEmbed(entries, page, pageSize, targetId) {
  const start = page * pageSize;
  const end = Math.min(entries.length, start + pageSize);
  const embed = colorManager.createEmbed()
    .setTitle('قائمة المشاكل')
    .setDescription(`**قائمة المشاكل للطرف** <@${targetId}>`)
    .setTimestamp();
  for (let i = start; i < end; i++) {
    const e = entries[i];
    // Format the timestamp in Riyadh time with an English locale
    const timeStr = new Date(e.timestamp).toLocaleString('en-US', { timeZone: 'Asia/Riyadh' });
    /*
     * Each problem entry is presented as a single field.  Using a single
     * non-inline field ensures that entries are visually separated within the
     * embed instead of being packed together with inline fields.  The field
     * name identifies the other party, and the value lists the timestamp
     * and responsible moderator on separate lines.  This approach prevents
     * issues from appearing merged together.
     */
    embed.addFields({
      name: `الطرف الآخر : <@${e.otherId}>`,
      value: `وقت المشكلة : ${timeStr}\nالمسؤول : <@${e.moderatorId}>`,
      inline: false
    });
  }
  embed.setFooter({ text: `صفحة ${page + 1} من ${Math.ceil(entries.length / pageSize)}` });
  return embed;
}

function buildNavRow(page, totalPages) {
  const prev = new ButtonBuilder()
    .setCustomId('myissues_prev')
    .setLabel('السابق')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(page === 0);
  const next = new ButtonBuilder()
    .setCustomId('myissues_next')
    .setLabel('التالي')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(page >= totalPages - 1);
  return new ActionRowBuilder().addComponents(prev, next);
}

async function handleInteraction(interaction, context) {
  const { client, BOT_OWNERS } = context;
  const id = interaction.customId;
  if (!id || !id.startsWith('myissues_')) return;
  // Only respond to button interactions
  if (!interaction.isButton()) return;
  const userId = interaction.user.id;
  const sessionStore = getSessionStore(client);
  const session = sessionStore.get(userId);
  if (!session) return;
  // Defer update
  if (!interaction.replied && !interaction.deferred) {
    await interaction.deferUpdate().catch((error) => {
      if (error?.code !== 10062) {
        console.error('Failed to defer myissues interaction:', error);
      }
    });
    if (!interaction.deferred && !interaction.replied) return;
  }
  const totalPages = Math.ceil(session.entries.length / session.pageSize);
  if (id === 'myissues_prev') {
    if (session.page > 0) session.page -= 1;
  } else if (id === 'myissues_next') {
    if (session.page < totalPages - 1) session.page += 1;
  }
  // Rebuild embed and nav
  const embed = buildPageEmbed(session.entries, session.page, session.pageSize, session.targetId);
  const row = buildNavRow(session.page, totalPages);
  try {
    // Edit original message
    const channel = interaction.channel;
    const msg = await channel.messages.fetch(session.messageId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed], components: [row] });
    }
  } catch (err) {
    console.error('Failed to edit myissues message:', err);
  }
}

module.exports = {
  name,
  aliases,
  execute,
  handleInteraction
};
