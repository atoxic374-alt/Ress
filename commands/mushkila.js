const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');

const interactionRouter = require('../utils/interactionRouter.js');
const colorManager = require('../utils/colorManager.js');

// Import the activeProblems map from the main problem module.  We do not
// destructure closeProblem here because this command only removes mute
// roles without closing the problem.
const { activeProblems, saveActiveProblemsToDisk } = require('./problem.js');

const fs = require('fs');
const path = require('path');

/**
 * Restore roles that were removed from a user due to a problem mute.  When a user is
 * unmuted manually via the مشكله command, any roles recorded in the problem's
 * removedAdminRoles or removedSendRoles arrays for that user are re-added.  The
 * function iterates over all active problems to handle cases where the same user
 * may be involved in multiple problems.  After restoring, the corresponding
 * entries are cleared from the problem data and any strict mode flag is removed.
 *
 * @param {Guild} guild The guild containing the member.
 * @param {string} userId The ID of the user whose roles should be restored.
 */
async function restoreRemovedRolesForUser(guild, userId) {
  try {
    const member = guild.members.cache.get(userId);
    if (!member) return;
    // Collect all roles to restore across all active problems
    const rolesToAdd = new Set();
    const overrideChannelIds = new Set();
    for (const [key, prob] of activeProblems.entries()) {
      // Skip if this problem does not involve the user
      if (prob.firstId !== userId && prob.secondId !== userId) continue;
      // Restore administrator roles
      if (prob.removedAdminRoles && prob.removedAdminRoles[userId]) {
        for (const roleId of prob.removedAdminRoles[userId]) {
          rolesToAdd.add(roleId);
        }
        // Clear the record for this user to avoid re-restoring later
        delete prob.removedAdminRoles[userId];
      }
      // Restore send-message roles
      if (prob.removedSendRoles && prob.removedSendRoles[userId]) {
        for (const roleId of prob.removedSendRoles[userId]) {
          rolesToAdd.add(roleId);
        }
        delete prob.removedSendRoles[userId];
      }
      // Remove any channel-level SendMessages denies that were applied during mute
      if (prob.removedSendOverrides && prob.removedSendOverrides[userId]) {
        for (const channelId of prob.removedSendOverrides[userId]) {
          overrideChannelIds.add(channelId);
        }
        delete prob.removedSendOverrides[userId];
      }
      // Clear strict mode flag for this user if present
      if (prob.strictMode && prob.strictMode[userId]) {
        delete prob.strictMode[userId];
      }
    }
    // Re-add the roles to the member.  Filter out roles that no longer exist in the guild or that the
    // member already has (to avoid redundant API calls).  Use try/catch per role to continue on errors.
    for (const roleId of rolesToAdd) {
      const roleObj = guild.roles.cache.get(roleId);
      if (!roleObj) continue;
      if (member.roles.cache.has(roleId)) continue;
      try {
        await member.roles.add(roleObj);
      } catch (err) {
        console.error(`Failed to restore role ${roleId} for user ${userId} in mushkila command:`, err);
      }
    }

    // Remove member-specific permission overwrites that were used to deny SendMessages.
    // We only remove the overwrite if it exists and does not contain any allow bits to avoid
    // deleting a custom allow configuration added manually for this user.
    for (const channelId of overrideChannelIds) {
      const channel = guild.channels.cache.get(channelId);
      if (!channel || !channel.permissionOverwrites) continue;
      const overwrite = channel.permissionOverwrites.cache.get(userId);
      if (!overwrite) continue;
      const hasAllowRules = overwrite.allow && overwrite.allow.bitfield !== 0n;
      if (hasAllowRules) continue;
      try {
        await channel.permissionOverwrites.delete(userId);
      } catch (err) {
        console.error(`Failed to remove overwrite in channel ${channelId} for user ${userId}:`, err);
      }
    }

    // Persist problem state updates (removed roles/overwrites/strict mode cleanup).
    if (typeof saveActiveProblemsToDisk === 'function') saveActiveProblemsToDisk();
  } catch (err) {
    console.error('Error restoring removed roles in mushkila command:', err);
  }
}

// Load problem configuration (mute role, responsible roles, etc.) from
// data/problemConfig.json.  This helper mirrors the implementation in
// end.js to avoid circular dependencies.  It returns sensible defaults
// when configuration values are missing or invalid.
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
        responsibleRoleIds: Array.isArray(config.responsibleRoleIds) ? config.responsibleRoleIds : [],
        separatorEnabled: typeof config.separatorEnabled === 'boolean' ? config.separatorEnabled : false,
        separatorImage: typeof config.separatorImage === 'string' ? config.separatorImage : null
      };
    }
  } catch (err) {
    console.error('Failed to load problemConfig in mushkila.js:', err);
  }
  return { logsChannelId: null, muteRoleId: null, muteDuration: 10 * 60 * 1000, responsibleRoleIds: [], separatorEnabled: false, separatorImage: null };
}

// Session store for this command.  We use a WeakMap keyed by client to
// maintain per-user interaction state without leaking memory.
const sessionStores = new WeakMap();
function getSessionStore(client) {
  if (!sessionStores.has(client)) sessionStores.set(client, new Map());
  return sessionStores.get(client);
}

// Determine whether a member is allowed to use this command.  A member
// qualifies if they are the guild owner, a BOT owner (from context), or
// possess at least one role from the configured responsibleRoleIds.
function userIsResponsible(member, owners) {
  if (!member) return false;
  // Guild owner always has permission
  if (member.id === member.guild.ownerId) return true;
  // BOT owners from context
  if (Array.isArray(owners) && owners.includes(member.id)) return true;
  // Check responsible roles from problemConfig
  try {
    const cfg = loadProblemConfig();
    const responsible = cfg.responsibleRoleIds || [];
    if (responsible.some((roleId) => member.roles.cache.has(roleId))) return true;
  } catch (_) {}
  return false;
}

// Name of the command exposed to users.  This is the Arabic word for
// "problem" and allows moderators to remove the mute role from users
// involved in problems without closing the case.
const name = 'مشكله';

/**
 * Execute the مشكله command.  When invoked without arguments, this command
 * displays a select menu listing all users who currently have the mute
 * role due to an active problem.  The invoking moderator can select one
 * or more users to unmute via the menu.  When invoked with mentions or
 * raw IDs, the command immediately removes the mute role from the
 * specified users.  Only moderators who hold one of the configured
 * responsible roles (or the guild/BOT owner) may use this command.  If
 * an unauthorised user attempts to run the command, a ❌ reaction is
 * added to the triggering message and no further action is taken.
 */
async function execute(message, args, context) {
  const { client } = context;
  const cfg = loadProblemConfig();
  const muteRoleId = cfg.muteRoleId;
  // If no mute role is configured, there is nothing to remove
  if (!muteRoleId) {
    return message.reply('⚠️ **لم يتم تحديد رول الميوت في الإعدادات.**');
  }
  // Check permissions: only responsible members (or owners) can use this command
  const owners = context.BOT_OWNERS || [];
  if (!userIsResponsible(message.member, owners)) {
    // Add a ❌ reaction to indicate lack of permissions.  If reacting fails (e.g. due to
    // missing permissions), fall back to sending a reply.
    try {
      await message.react('❌');
    } catch (_) {
      await message.reply('❌ **ليس لديك صلاحية استخدام هذا الأمر.**');
    }
    return;
  }
  // If the command includes mentions or raw IDs, unmute those users immediately
  const targetIds = [];
  if (message.mentions.users.size > 0) {
    for (const user of message.mentions.users.values()) {
      targetIds.push(user.id);
    }
  } else if (args && args.length > 0) {
    for (const arg of args) {
      const id = arg.replace(/[^\d]/g, '');
      if (id) targetIds.push(id);
    }
  }
  if (targetIds.length > 0) {
    const unmuted = [];
    for (const id of targetIds) {
      const member = message.guild.members.cache.get(id);
      if (member && member.roles.cache.has(muteRoleId)) {
        try {
          // Remove the mute role
          await member.roles.remove(muteRoleId);
          // Restore any roles that were removed during the problem
          await restoreRemovedRolesForUser(message.guild, id);
          unmuted.push(id);
        } catch (err) {
          console.error('Failed to unmute user in mushkila command:', err);
        }
      }
    }
    if (unmuted.length > 0) {
      return message.reply('✅ **تم فك الميوت عن:** ' + unmuted.map((id) => `<@${id}>`).join(' ، '));
    }
    return message.reply('⚠️ **لم يتم العثور على مستخدمين لديهم ميوت.**');
  }
  // Otherwise, build a list of all users who are currently muted in active problems
  const guild = message.guild;
  const candidateIds = new Set();
  // Collect unique user IDs from all active problems
  for (const [key, prob] of activeProblems.entries()) {
    candidateIds.add(prob.firstId);
    candidateIds.add(prob.secondId);
  }
  const options = [];
  for (const userId of candidateIds) {
    const member = guild.members.cache.get(userId);
    if (member && member.roles.cache.has(muteRoleId)) {
      options.push({
        label: member.displayName || member.user.username,
        description: userId,
        value: userId
      });
    }
  }
  if (options.length === 0) {
    return message.reply('⚠️ **لا يوجد أي مستخدم مع رول الميوت حاليًا ضمن المشاكل.**');
  }
  // Store session so we can handle the selection interaction later
  const sessionStore = getSessionStore(client);
  sessionStore.set(message.author.id, { options });
  // Build the select menu for the user to choose whom to unmute
  const select = new StringSelectMenuBuilder()
    .setCustomId('mushkila_select_unmute')
    .setPlaceholder('اختر الأعضاء لإزالة الميوت')
    .setMinValues(1)
    .setMaxValues(options.length)
    .addOptions(options);
  const row = new ActionRowBuilder().addComponents(select);
  const embed = colorManager
    .createEmbed()
    .setTitle('إزالة الميوت عن الأعضاء')
    .setDescription('اختر الأعضاء الذين تريد فك الميوت عنهم.')
    .setTimestamp();
  const sent = await message.channel.send({ embeds: [embed], components: [row] });
  // Set up a collector to clean up the menu after five minutes.  Restrict
  // interactions to the invoking user.
  try {
    const filter = (i) => i.user.id === message.author.id;
    const collector = sent.createMessageComponentCollector({ filter, time: 5 * 60 * 1000 });
    collector.on('end', async () => {
      try {
        await sent.edit({ components: [] }).catch(() => {});
        const store = getSessionStore(client);
        store.delete(message.author.id);
      } catch (_) {
        // ignore cleanup errors
      }
    });
  } catch (_) {
    // If collector creation fails, proceed without restricting interactions
  }
  // Register router for this command once per client.
  // Note: interaction routing is already handled globally in bot.js,
  // so we must NOT attach another interactionCreate listener here.
  if (!client._mushkilaRouterRegistered) {
    const ownersList = context.BOT_OWNERS || [];
    interactionRouter.register('mushkila_', async (interaction, routerContext = {}) => {
      const resolvedClient = routerContext.client || (routerContext.ws ? routerContext : client);
      const resolvedOwners = routerContext.BOT_OWNERS || ownersList;
      await handleInteraction(interaction, { client: resolvedClient, BOT_OWNERS: resolvedOwners });
    });
    client._mushkilaRouterRegistered = true;
  }
}

/**
 * Handle the select menu interaction for the مشكله command.  Removes the
 * mute role from each selected user and sends an acknowledgement to the
 * moderator.  Only processes interactions for which we have stored
 * session data.
 */
async function handleInteraction(interaction, context) {
  const { client, BOT_OWNERS } = context;
  const id = interaction.customId;
  if (!id || id !== 'mushkila_select_unmute') return;
  // Retrieve session for the invoking user
  const sessionStore = getSessionStore(client);
  const session = sessionStore.get(interaction.user.id);
  if (!session) return;
  // Defer the update to acknowledge the interaction
  if (!interaction.replied && !interaction.deferred) {
    await interaction.deferUpdate().catch(() => {});
  }
  const selectedIds = interaction.values || [];
  const guild = interaction.guild;
  const cfg = loadProblemConfig();
  const muteRoleId = cfg.muteRoleId;
  const unmuted = [];
  for (const uid of selectedIds) {
    const member = guild.members.cache.get(uid);
    if (member && member.roles.cache.has(muteRoleId)) {
      try {
        // Remove the mute role
        await member.roles.remove(muteRoleId);
        // Restore any roles removed for this user across all active problems
        await restoreRemovedRolesForUser(guild, uid);
        unmuted.push(uid);
      } catch (err) {
        console.error('Failed to unmute user in mushkila select:', err);
      }
    }
  }
  if (unmuted.length > 0) {
    await interaction.followUp({ content: '✅ **تم فك الميوت عن:** ' + unmuted.map((id) => `<@${id}>`).join(' ، '), ephemeral: true });
  } else {
    await interaction.followUp({ content: '⚠️ **لم يتم العثور على مستخدمين لإزالة الميوت.**', ephemeral: true });
  }
  // Remove session data for this user
  sessionStore.delete(interaction.user.id);
}

module.exports = {
  name,
  execute,
  handleInteraction
};
