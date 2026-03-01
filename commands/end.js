const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');

const interactionRouter = require('../utils/interactionRouter.js');
const colorManager = require('../utils/colorManager.js');

const { activeProblems, getProblemKey, closeProblem } = require('./problem.js');

const fs = require('fs');
const path = require('path');

// Load problem configuration (logs channel, mute role, etc.) from data/problemConfig.json.
// We replicate the helper here to avoid circular dependencies.
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
    console.error('Failed to load problemConfig in end.js:', err);
  }
  return { logsChannelId: null, muteRoleId: null, muteDuration: 10 * 60 * 1000, responsibleRoleIds: [], separatorEnabled: false, separatorImage: null };
}

// Load admin roles helper (similar to problem.js) to restrict command usage
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

// Session store for this command (separate from problem session store)
const sessionStores = new WeakMap();
function getSessionStore(client) {
  if (!sessionStores.has(client)) sessionStores.set(client, new Map());
  return sessionStores.get(client);
}

// Helper to check if member is allowed: owner or admin role
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

// Helper to determine if member is owner/responsible (BOT_OWNERS).  A
// super moderator can end any problem.  Admin roles can only end
// problems they created.
function isOwnerOrResponsible(member, owners) {
  if (!member) return false;
  if (member.id === member.guild.ownerId) return true;
  if (Array.isArray(owners) && owners.includes(member.id)) return true;
  // Check responsible roles from problemConfig
  try {
    const cfg = loadProblemConfig();
    const responsible = cfg.responsibleRoleIds || [];
    if (responsible.some((roleId) => member.roles.cache.has(roleId))) return true;
  } catch (_) {}
  return false;
}

const name = 'انهاء';

async function execute(message, args, context) {
  const { client } = context;
  const adminRoles = loadAdminRoles();
  const owners = context.BOT_OWNERS || [];
  if (!userIsModerator(message.member, adminRoles, owners)) {
    return message.reply('❌ **ليس لديك صلاحية استخدام هذا الأمر.**');
  }
  // Require a target mention or ID
  if (args.length < 1 && message.mentions.users.size === 0) {
    return message.reply('❌ **الرجاء منشن الشخص أو إدخال الـ ID الخاص به بعد الأمر.**');
  }
  // Determine target user ID
  let targetId;
  if (message.mentions.users.size > 0) {
    targetId = message.mentions.users.first().id;
  } else {
    targetId = args[0].replace(/[^\d]/g, '');
  }
  if (!targetId) {
    return message.reply('❌ **لم يتم العثور على معرف صالح للطرف.**');
  }
  const guild = message.guild;
  // Determine if the moderator is super (owner/responsible)
  const isSuper = isOwnerOrResponsible(message.member, owners);
  // Build list of problems for this user.  If moderator is not super,
  // only include problems they themselves created.
  const options = [];
  for (const [key, prob] of activeProblems.entries()) {
    if (prob.firstId === targetId || prob.secondId === targetId) {
      // If not super, skip problems created by others
      if (!isSuper && prob.moderatorId !== message.author.id) {
        continue;
      }
      const otherId = prob.firstId === targetId ? prob.secondId : prob.firstId;
      const otherMember = guild.members.cache.get(otherId);
      const otherName = otherMember ? otherMember.displayName : otherId;
      options.push({
        label: otherName,
        description: `**بدأت في ${new Date(prob.timestamp).toLocaleString('en-US')}**`,
        value: key
      });
    }
  }
  if (options.length === 0) {
    return message.reply('⚠️ **لا توجد مشاكل مسجّلة لهذا العضو.**');
  }
  // Save session
  const sessionStore = getSessionStore(client);
  sessionStore.set(message.author.id, { targetId, options });
  // Build select menu
  const select = new StringSelectMenuBuilder()
    .setCustomId('end_select_problem')
    .setPlaceholder('اختر المشاكل التي تريد إنهاءها')
    .setMinValues(1)
    .setMaxValues(options.length)
    .addOptions(options);
  const row = new ActionRowBuilder().addComponents(select);
  const embed = colorManager.createEmbed()
    .setTitle('إنهاء المشاكل')
    .setDescription(`**اختر المشكلة أو المشاكل التي تريد إنهاءها للطرف** <@${targetId}>`)
    .setTimestamp();
  // Send the selection embed without an extra mention
  const sent = await message.channel.send({ embeds: [embed], components: [row] });

  // Restrict interaction to the invoking user and end the menu after a timeout
  try {
    const filter = (i) => i.user.id === message.author.id;
    const collector = sent.createMessageComponentCollector({ filter, time: 5 * 60 * 1000 });
    collector.on('end', async () => {
      try {
        // Remove all components to disable further selections
        await sent.edit({ components: [] }).catch(() => {});
        // Clean up any stored session for this user
        const sessionStoreEnd = getSessionStore(context.client);
        sessionStoreEnd.delete(message.author.id);
      } catch (_) {
        // ignore cleanup errors
      }
    });
  } catch (_) {
    // If collector creation fails, proceed without adding restrictions
  }
  // Register router for end command
  if (!client._endRouterRegistered) {
    const ownersList = context.BOT_OWNERS || [];
    interactionRouter.register('end_', async (interaction, client) => {
      await handleInteraction(interaction, { client, BOT_OWNERS: ownersList });
    });
    if (!client._interactionRouterListenerAdded) {
      client.on('interactionCreate', async (interaction) => {
        await interactionRouter.route(interaction, client);
      });
      client._interactionRouterListenerAdded = true;
    }
    client._endRouterRegistered = true;
  }
}

async function handleInteraction(interaction, context) {
  const { client, BOT_OWNERS } = context;
  const id = interaction.customId;
  if (!id || id !== 'end_select_problem') return;
  // Get session
  const sessionStore = getSessionStore(client);
  const session = sessionStore.get(interaction.user.id);
  if (!session) return;
  // Defer update
  if (!interaction.replied && !interaction.deferred) {
    await interaction.deferUpdate().catch(() => {});
  }
  const selectedKeys = interaction.values || [];
  const guild = interaction.guild;
  // Determine if moderator is super (owner/responsible)
  const owners = context.BOT_OWNERS || [];
  const moderator = guild.members.cache.get(interaction.user.id);
  const isSuper = isOwnerOrResponsible(moderator, owners);
  // End selected problems; restrict if not super
  let endedAny = false;
  for (const key of selectedKeys) {
    const prob = activeProblems.get(key);
    if (!prob) continue;
    if (!isSuper && prob.moderatorId !== interaction.user.id) {
      // Skip problems not created by this moderator
      continue;
    }
    // Pass the ID of the moderator ending the problem so that closeProblem can
    // include it in logs and DMs.
    await closeProblem(key, guild, { client, BOT_OWNERS, endedBy: interaction.user.id });
    endedAny = true;
  }
  if (endedAny) {
    await interaction.followUp({ content: '✅ **تم إنهاء المشاكل المحددة.**', ephemeral: true });
  } else {
    await interaction.followUp({ content: '⚠️ **لا يوجد أي من المشاكل المحددة يسمح لك بإنهائها.**', ephemeral: true });
  }
  // Remove session
  sessionStore.delete(interaction.user.id);
}

module.exports = {
  name,
  execute,
  handleInteraction
};