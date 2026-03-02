const {
  EmbedBuilder,
  ActionRowBuilder,
  UserSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
  ChannelType,
  AttachmentBuilder,
  AuditLogEvent
} = require('discord.js');

const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');

const interactionRouter = require('../utils/interactionRouter.js');
const colorManager = require('../utils/colorManager.js');

// Default thumbnail URL for interactive embeds (problem creation flows).
const LOG_THUMBNAIL_URL = 'https://cdn.discordapp.com/attachments/1294840822780526633/1465458307329167360/problem-solving.png?ex=69792de7&is=6977dc67&hm=876028d8022c57e8258ee956d753608a9d247e1e5f774a62f149f29f1200a673&';

function buildProblemEmbed(title, description, thumbnailUrl) {
  const embed = colorManager.createEmbed().setTitle(title).setDescription(description).setTimestamp();
  if (thumbnailUrl) {
    embed.setThumbnail(thumbnailUrl);
  }
  return embed;
}

// Load admin roles utility from the perm command.  We copy the helper here
// to avoid importing the entire perm module which would create a circular
// dependency.  This helper reads the data/adminRoles.json file and returns
// an array of role IDs.  If the file cannot be read, an empty array is
// returned.
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

function loadBotOwners() {
  const fromGlobal = Array.isArray(global.BOT_OWNERS) ? global.BOT_OWNERS : [];
  if (fromGlobal.length > 0) return fromGlobal;

  try {
    const botConfigPath = path.join(__dirname, '..', 'data', 'botConfig.json');
    if (fs.existsSync(botConfigPath)) {
      const botConfig = JSON.parse(fs.readFileSync(botConfigPath, 'utf8'));
      return Array.isArray(botConfig.owners) ? botConfig.owners : [];
    }
  } catch (error) {
    console.error('Error reading bot owners in problem.js:', error);
  }

  return [];
}

// Problem configuration (logs channel, mute role, mute duration).  These
// values are loaded from a JSON file on disk so they persist between
// restarts.  The config file is stored in data/problemConfig.json.  If
// the file does not exist, defaults are used.
function loadProblemConfig() {
  try {
    const configPath = path.join(__dirname, '..', 'data', 'problemConfig.json');
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(data);
      // Validate types and provide defaults
        return {
        logsChannelId: typeof config.logsChannelId === 'string' ? config.logsChannelId : null,
        muteRoleId: typeof config.muteRoleId === 'string' ? config.muteRoleId : null,
        muteDuration: typeof config.muteDuration === 'number' ? config.muteDuration : 10 * 60 * 1000,
        responsibleRoleIds: Array.isArray(config.responsibleRoleIds) ? config.responsibleRoleIds : [],
        // Separator line enabled flag. When true, a horizontal line image is attached to each log message.
        separatorEnabled: typeof config.separatorEnabled === 'boolean' ? config.separatorEnabled : false,
        // Optional custom separator image URL. When set, this URL will be used for the line image instead of the default asset.
        separatorImage: typeof config.separatorImage === 'string' ? config.separatorImage : null,
        adminProblemEnabled: typeof config.adminProblemEnabled === 'boolean' ? config.adminProblemEnabled : true
      };
    }
  } catch (err) {
    console.error('Failed to load problemConfig:', err);
  }
  // default configuration
  return { logsChannelId: null, muteRoleId: null, muteDuration: 10 * 60 * 1000, responsibleRoleIds: [], separatorEnabled: false, separatorImage: null, adminProblemEnabled: true };
}

function saveProblemConfig(config) {
  try {
    const configPath = path.join(__dirname, '..', 'data', 'problemConfig.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save problemConfig:', err);
  }
}

async function getLogsChannel(guild, logsChannelId) {
  if (!guild || !logsChannelId) return null;
  const cached = guild.channels.cache.get(logsChannelId);
  if (cached) return cached;
  return guild.channels.fetch(logsChannelId).catch(() => null);
}

// Session store for interactive flows.  This uses a WeakMap keyed by
// client to store a Map keyed by user ID.  This pattern matches the
// implementation used by the perm command.  Each entry stores data
// relevant to the current interaction (selected parties, reason, etc.).
const sessionStores = new WeakMap();
function getSessionStore(client) {
  if (!sessionStores.has(client)) {
    sessionStores.set(client, new Map());
  }
  return sessionStores.get(client);
}

    // Active problem cases.  This map tracks ongoing problems between two
    // parties.  The key is a string of sorted user IDs ("id1|id2").  Each
    // value stores the parties, reason, moderator, timestamp, warnings per
    // party, and any active channel locks.  Problems are now persisted to
    // disk so that they survive bot restarts.  The active problems are
    // loaded from a JSON file on startup and saved back whenever they are
    const activeProblems = new Map();

// Debounce timer for saving activeProblems to disk.  When set, calls to
// saveActiveProblemsToDisk() will defer actual disk writes until the timer
// expires.  This helps improve performance by coalescing multiple
// modifications into a single write operation.
let saveActiveProblemsTimeout = null;

// Keep track of the most recently used Discord client so that scheduled tasks
// (such as daily resets) can access guilds and channels.  This will be
// updated whenever handleMessage or handleVoice is invoked.
let lastClient = null;

    /**
     * Load active problems from disk into the activeProblems map.
     * The data file is stored at data/activeProblems.json relative to this module.
     * If the file does not exist or cannot be parsed, the map remains empty.
     */
function loadActiveProblemsFromDisk() {
      try {
        const dataPath = path.join(__dirname, '..', 'data', 'activeProblems.json');
        if (fs.existsSync(dataPath)) {
          const raw = fs.readFileSync(dataPath, 'utf8');
          const json = JSON.parse(raw);
          activeProblems.clear();
          const normalizedProblems = new Map();
          for (const [key, value] of Object.entries(json)) {
            if (!value || !value.firstId || !value.secondId) continue;
            const canonicalKey = getProblemKey(value.firstId, value.secondId, value.guildId || null);
            if (!normalizedProblems.has(canonicalKey)) {
              normalizedProblems.set(canonicalKey, value);
            }
          }
          for (const [canonicalKey, problemValue] of normalizedProblems.entries()) {
            activeProblems.set(canonicalKey, problemValue);
          }
        }
      } catch (err) {
        console.error('Failed to load activeProblems from disk:', err);
      }
    }

    /**
     * Persist the current activeProblems map to disk.
     * The map is serialized to a plain object and written to data/activeProblems.json.
     */
    function saveActiveProblemsToDisk() {
      try {
        // Debounce writes to disk to prevent excessive synchronous I/O.  Multiple
        // calls within a short interval will schedule a single save operation.
        if (typeof saveActiveProblemsTimeout !== 'undefined' && saveActiveProblemsTimeout) {
          return;
        }
        // Schedule the actual save after a short delay to coalesce updates.  The delay
        // can be adjusted; 500ms is a reasonable compromise between responsiveness
        // and reducing disk writes.
        saveActiveProblemsTimeout = setTimeout(() => {
          try {
            const dataDir = path.join(__dirname, '..', 'data');
            if (!fs.existsSync(dataDir)) {
              fs.mkdirSync(dataDir, { recursive: true });
            }
            const dataPath = path.join(dataDir, 'activeProblems.json');
            const obj = {};
            for (const [key, value] of activeProblems.entries()) {
              obj[key] = value;
            }
            // Use asynchronous write to avoid blocking the event loop
            fs.writeFile(dataPath, JSON.stringify(obj, null, 2), 'utf8', (err) => {
              if (err) {
                console.error('Failed to save activeProblems to disk:', err);
              }
            });
          } catch (err) {
            console.error('Failed to save activeProblems to disk:', err);
          } finally {
            // Reset the timeout reference so that subsequent calls can schedule a new save
            saveActiveProblemsTimeout = null;
          }
        }, 500);
      } catch (err) {
        console.error('Failed to schedule save for activeProblems:', err);
      }
    }

    // On module load, attempt to load any persisted active problems.
    loadActiveProblemsFromDisk();

// Duplicate persistence functions removed - see the earlier definitions above

// Channel locks: when a user is kicked from a voice channel due to
// approaching the other party, we deny their Connect permission for a
// specified duration.  This map tracks locks keyed by
// `${channelId}:${userId}` with expiry timestamp.  After expiry the
// permission override should be removed.
const channelLocks = new Map();

/**
 * Download a remote image to the assets directory for use as a separator.
 * When a user provides an attachment or URL for the separator image, we
 * download it locally so that the bot can reliably re-use the image even
 * after the original link expires.  The downloaded file will be saved
 * under assets/custom_separator.<ext>.  Returns the absolute path to the
 * downloaded image.  Throws on failure.
 * @param {string} url - The URL of the remote image to download.
 * @returns {Promise<string>} - Resolves to the absolute path of the saved file.
 */
const ALLOWED_SEPARATOR_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
  'images-ext-1.discordapp.net',
  'images-ext-2.discordapp.net'
]);

function isPrivateIpAddress(address) {
  if (!address) return true;
  if (net.isIP(address) === 4) {
    return (
      address.startsWith('10.') ||
      address.startsWith('127.') ||
      address.startsWith('169.254.') ||
      address.startsWith('172.16.') ||
      address.startsWith('172.17.') ||
      address.startsWith('172.18.') ||
      address.startsWith('172.19.') ||
      address.startsWith('172.20.') ||
      address.startsWith('172.21.') ||
      address.startsWith('172.22.') ||
      address.startsWith('172.23.') ||
      address.startsWith('172.24.') ||
      address.startsWith('172.25.') ||
      address.startsWith('172.26.') ||
      address.startsWith('172.27.') ||
      address.startsWith('172.28.') ||
      address.startsWith('172.29.') ||
      address.startsWith('172.30.') ||
      address.startsWith('172.31.') ||
      address.startsWith('192.168.')
    );
  }
  if (net.isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
  }
  return true;
}

async function validateSeparatorUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    throw new Error('INVALID_URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('ONLY_HTTPS_ALLOWED');
  }

  const hostname = (parsed.hostname || '').toLowerCase();
  if (!ALLOWED_SEPARATOR_HOSTS.has(hostname)) {
    throw new Error('HOST_NOT_ALLOWED');
  }

  const lookups = await dns.promises.lookup(hostname, { all: true });
  if (!Array.isArray(lookups) || lookups.length === 0) {
    throw new Error('DNS_LOOKUP_FAILED');
  }

  for (const entry of lookups) {
    if (isPrivateIpAddress(entry.address)) {
      throw new Error('PRIVATE_IP_NOT_ALLOWED');
    }
  }

  return parsed;
}

async function downloadSeparatorImage(url) {
  const parsedUrl = await validateSeparatorUrl(url);

  return new Promise((resolve, reject) => {
    try {
      const extMatch = parsedUrl.pathname.match(/\.[a-zA-Z0-9]+$/);
      const ext = extMatch ? extMatch[0] : '.png';
      const assetsDir = path.join(__dirname, '..', 'assets');
      if (!fs.existsSync(assetsDir)) {
        fs.mkdirSync(assetsDir, { recursive: true });
      }
      // Save with a consistent name so that old custom images are overwritten
      const dest = path.join(assetsDir, 'custom_separator' + ext.toLowerCase());
      const file = fs.createWriteStream(dest);
      const protocol = require('https');
      const request = protocol.get(parsedUrl.toString(), (response) => {
        if (response.statusCode !== 200) {
          file.close(() => {
            fs.unlink(dest, () => {});
            reject(new Error('Failed to download image: status ' + response.statusCode));
          });
          return;
        }
        const contentType = String(response.headers['content-type'] || '').toLowerCase();
        if (!contentType.startsWith('image/')) {
          file.close(() => {
            fs.unlink(dest, () => {});
            reject(new Error('INVALID_CONTENT_TYPE'));
          });
          return;
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close(() => resolve(dest));
        });
      });
      request.setTimeout(10000, () => {
        request.destroy(new Error('REQUEST_TIMEOUT'));
      });
      request.on('error', (err) => {
        file.close(() => {
          fs.unlink(dest, () => {});
          reject(err);
        });
      });
    } catch (err) {
      reject(err);
    }
  });
}

// Constants for daily warning resets.  Warnings and responses for each problem
// are reset once every 24 hours so that each new day begins with a clean
// slate.  This makes the next violation count as a first warning again.
const WARNING_RESET_INTERVAL = 60 * 60 * 1000; // check every hour
const WARNING_RESET_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours

// Periodically reset warnings and responses for all active problems.  This
// scheduled task runs once an hour and iterates through all problems.  If
// more than 24 hours have passed since the last reset (or creation), the
// warnings, responses and voice warnings for that problem are cleared and a
// log message is posted to the logs channel.  The updated state is persisted
// to disk.  This ensures that long-running problems do not accumulate old
// warnings indefinitely.
setInterval(async () => {
  // If the bot has not yet processed any events, we may not have a client
  // reference.  In that case, skip until handleMessage or handleVoice sets it.
  if (!lastClient) return;
  const now = Date.now();
  // Collect problems that need to be reset grouped by guild.  After resets are performed,
  // we will send a single summary log per guild rather than one log per problem.
  const resetsByGuild = {};
  for (const [key, prob] of activeProblems.entries()) {
    const lastReset = prob.lastWarningReset || prob.timestamp;
    if (now - lastReset >= WARNING_RESET_THRESHOLD) {
      // Reset warnings, responses and voice warnings
      prob.warnings = {};
      prob.responses = {};
      prob.voiceWarned = {};
      prob.voiceWarnedHigh = {};
      prob.voiceOwnerNotified = {};
      prob.voiceLoggedHigh = {};
      prob.lastWarningReset = now;
      // Persist the update
      saveActiveProblemsToDisk();
      // Record this problem for summary logging
      if (!resetsByGuild[prob.guildId]) resetsByGuild[prob.guildId] = [];
      resetsByGuild[prob.guildId].push(prob);
    }
  }
  // Silent daily reset by request: do not send renewal/reset embeds to logs.
}, WARNING_RESET_INTERVAL);

// Track users for whom a mute removal warning has already been sent.  This
// prevents spamming the logs channel when an unauthorised user repeatedly
// tries to remove the mute role.  Entries are cleared when the problem is
// closed via closeProblem().
const muteRemovalWarned = new Set();

    // Track users for whom we have already logged a role re-addition event to prevent spamming logs.
    const roleReaddWarned = new Set();

// Register global message and voice handlers once per client.  We
// attach handlers lazily when the first problem is created.  This
// prevents multiple listeners from being added if the command is used
// multiple times.
function registerProblemListeners(client) {
  if (client._problemListenersInitialized) return;
  client._problemListenersInitialized = true;
  client.on('messageCreate', (msg) => handleMessage(msg, client));
  client.on('voiceStateUpdate', (oldState, newState) => handleVoice(oldState, newState, client));
  // Monitor role removals: re-apply mute role if removed by unauthorized user
  client.on('guildMemberUpdate', (oldMember, newMember) => handleMemberUpdate(oldMember, newMember, client));
  // Periodically clear expired channel locks.  We use a timer rather than
  // scheduling individual timeouts to reduce overhead.  This runs every
  // minute and removes overrides whose expiry has passed.
  setInterval(() => {
    const now = Date.now();
    for (const [key, lock] of channelLocks.entries()) {
      if (now >= lock.expiresAt) {
        channelLocks.delete(key);
        // key format is channelId:userId
        const [channelId, userId] = key.split(':');
        const guild = client.guilds.cache.get(lock.guildId);
        if (guild) {
          const channel = guild.channels.cache.get(channelId);
          if (channel) {
            // Remove permission override if it exists
            channel.permissionOverwrites.delete(userId).catch(() => {});
          }
        }
      }
    }
  }, 60 * 1000);
}

// Utility: generate problem key for two user IDs (order independent)
function getProblemKey(id1, id2, guildId = null) {
  const pair = [id1, id2].sort().join('|');
  return guildId ? `${guildId}:${pair}` : pair;
}

// Check if the user is the owner of the bot or has an admin role.  We
// assume that owner IDs are provided via environment variable or
// context.  Because we don't have direct access to BOT_OWNERS here, we
// accept an optional owners array in the context when calling
// execute/handleInteraction.  If the array is not provided, only the
// guild owner passes.
function userIsModerator(member, adminRoles, owners) {
  // Always allow guild owner
  if (member.id === member.guild.ownerId) return true;
  // Owners from context
  if (Array.isArray(owners) && owners.includes(member.id)) return true;
  // Responsible roles from problem config
  try {
    const cfg = loadProblemConfig();
    const responsible = cfg.responsibleRoleIds || [];
    if (responsible.some((roleId) => member.roles.cache.has(roleId))) return true;
  } catch (_) {}
  // Admin roles from config
  if (adminRoles.some((roleId) => member.roles.cache.has(roleId))) return true;
  return false;
}

// Determine if a member is an owner or responsible (BOT_OWNERS).  This
// helper distinguishes super moderators from regular admin roles.
function isOwnerOrResponsible(member, owners) {
  if (!member) return false;
  if (member.id === member.guild.ownerId) return true;
  if (Array.isArray(owners) && owners.includes(member.id)) return true;
  // Check responsible roles from problem config
  try {
    const cfg = loadProblemConfig();
    const responsible = cfg.responsibleRoleIds || [];
    if (responsible.some((roleId) => member.roles.cache.has(roleId))) return true;
  } catch (_) {}
  return false;
}

// Determine if a member has an admin role (from adminRoles file).  This
// does not include owners/responsibles.
function isAdmin(member, adminRoles) {
  if (!member) return false;
  return adminRoles.some((roleId) => member.roles.cache.has(roleId));
}

function getProblemOwners(client) {
  if (client && Array.isArray(client._problemOwners) && client._problemOwners.length > 0) {
    return client._problemOwners;
  }
  if (global.BOT_OWNERS && Array.isArray(global.BOT_OWNERS)) {
    return global.BOT_OWNERS;
  }
  return [];
}

// Command name and aliases
const name = 'problem';

async function execute(message, args, context) {
  const { client } = context;
  if (client) lastClient = client;
  const adminRoles = loadAdminRoles();
  const owners = context.BOT_OWNERS || [];

  // Store bot owner IDs on the client so that message handlers can notify owners
  // when a privileged user responds in a problem.  We update this on every
  // invocation to reflect the most recent configuration passed via context.
  try {
    if (Array.isArray(owners)) {
      client._problemOwners = owners;
    }
  } catch (_) {
    // ignore errors
  }
  const member = message.member;
  // Permission check: only owners or admin roles can use the command
  if (!userIsModerator(member, adminRoles, owners)) {
    return message.reply('❌ **ليس لديك صلاحية استخدام هذا الأمر.**');
  }

  // Ensure that problem config exists and load it
  const config = loadProblemConfig();

  // When admin-problem mode is disabled, allow only guild owner, bot owners, or responsible roles.
  if (config.adminProblemEnabled === false && !isOwnerOrResponsible(member, owners)) {
    return message.reply('❌ **تم تعطيل فتح البروبلم للإدارة. المسموح فقط لمالك السيرفر، الرولات المسؤولة، وأونرز البوت.**');
  }

  // If user invoked setup subcommand, delegate to executeSetup
  if (args.length > 0) {
    const sub = args[0].toLowerCase();
    if (sub === 'setup') {
      // Remove the 'setup' token and forward remaining args
      return executeSetup(message, args.slice(1), context);
    }
    if (sub === 'test') {
      return sendSeparatorTest(message);
    }
    // Remove handling of the legacy inline `problem end`/`finish`/`close` subcommand.
    // Previously this branch delegated to executeEnd(), but the separate `end` command
    // now manages closing problems.  We intentionally do nothing here so that
    // invoking `problem end` will fall through to the interactive problem creation
    // flow rather than silently closing problems.
  }

  // Register global listeners if not already done
  registerProblemListeners(client);

  // Register interaction router handler for problem prefix.  Use a flag on the
  // client to ensure this is only done once per client instance.  We need
  // to capture BOT_OWNERS from context for permission checks in the
  // interaction handler.
  if (!client._problemRouterRegistered) {
    const ownersList = context.BOT_OWNERS || [];
    interactionRouter.register('problem_', async (interaction, context = {}) => {
      const resolvedClient = context.client || (context.ws ? context : client);
      return handleInteraction(interaction, { client: resolvedClient, BOT_OWNERS: context.BOT_OWNERS || ownersList });
    });
    client._problemRouterRegistered = true;
  }

  // Begin interactive flow using user select menus.  Create a session
  // keyed by the invoking user ID.  If a session already exists for
  // this user, overwrite it.
  const sessionStore = getSessionStore(client);
  sessionStore.set(message.author.id, {
    step: 'selectFirst',
    guildId: message.guild.id,
    moderatorId: message.author.id,
    config
  });

  // Build user select menu for first party.  Allow multiple selection.
  const firstMenu = new UserSelectMenuBuilder()
    .setCustomId('problem_select_first')
    .setPlaceholder('اختر الطرف الأول (يمكن اختيار أكثر من شخص)')
    .setMinValues(1)
    .setMaxValues(5); // up to 5 users

  const embed = colorManager.createEmbed()
    .setTitle('Create problem')
    .setDescription('**اختر الطرف الأول**\nيمكنك اختيار عضو واحد أو أكثر.')
    .setThumbnail(message.guild.iconURL({ dynamic: true }));
  

  const row = new ActionRowBuilder().addComponents(firstMenu);
  // Send the interactive embed and components without extra mentions
  const sent = await message.channel.send({ embeds: [embed], components: [row] });

  // --- Restrict interaction to the command invoker and auto-end after a timeout ---
  // Create a component collector scoped to this message.  The filter permits only
  // the original command author to interact with the select menus.  Other users
  // attempting to interact will simply see the default “interaction failed” message
  // because the filter returns false and no handler is executed.  Once the
  // collector expires (after five minutes), all interactive components are
  // removed from the message to prevent further input.
  try {
    const filter = (i) => i.user.id === message.author.id;
    const collector = sent.createMessageComponentCollector({ filter, time: 5 * 60 * 1000 });
    collector.on('end', async () => {
      try {
        // Remove all components to end the interaction gracefully
        await sent.edit({ components: [] }).catch(() => {});
        // Clean up any session data for this user if it exists
        const sessionStore = getSessionStore(context.client);
        sessionStore.delete(message.author.id);
      } catch (_) {
        // Ignore any errors during cleanup
      }
    });
  } catch (_) {
    // If collector creation fails, continue without interactive restrictions
  }
}

async function handleInteraction(interaction, context) {
  const { client, BOT_OWNERS } = context;
  // Only handle customIds starting with problem_
  const id = interaction.customId;
  if (!id || !id.startsWith('problem_') || id.startsWith('problem_setup_')) return false;
  const sessionStore = getSessionStore(client);
  const session = sessionStore.get(interaction.user.id);
  if (!session) {
    return false; // no session for this user
  }
  try {
    // Defer update to avoid timeouts.  For component interactions we use
    // deferUpdate; for modal submissions we don't need to defer.
     
    if (id === 'problem_select_first') {
      // Save selected first parties and move to selecting second parties
      // Acknowledge the interaction via deferUpdate to avoid timeout when editing the message.
      if (!interaction.replied && !interaction.deferred) {
        await interaction.deferUpdate().catch(() => {});
      }
      session.firstParties = interaction.values;
      session.step = 'selectSecond';
      // Build user select menu for second parties.  Allow selecting multiple,
      // but exclude the already selected users from options by setting max.
      const secondMenu = new UserSelectMenuBuilder()
        .setCustomId('problem_select_second')
        .setPlaceholder('اختر الطرف الثاني ')
        .setMinValues(1)
        .setMaxValues(5);
      const embed = colorManager.createEmbed()
        .setTitle('Create problem')
        .setDescription('**اختر الطرف الثاني**\nيجب اختيار عضو واحد أو أكثر.')
        .setThumbnail(interaction.guild?.iconURL({ dynamic: true }) || null);

  
      const row = new ActionRowBuilder().addComponents(secondMenu);
      // Update the original message with the new embed and components
      await interaction.message.edit({ embeds: [embed], components: [row] });
      return;
    }
    if (id === 'problem_select_second') {
      // Prevent duplicate handling for the same interaction step.
      if (session.openingReasonModal) {
        return;
      }
      session.openingReasonModal = true;

      try {
      // Validate that selected second parties are allowed based on moderator's role
      const selectedIds = interaction.values;
      const guild = interaction.guild;
      if (!guild) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '❌ **تعذر العثور على السيرفر لهذا التفاعل.**', ephemeral: true }).catch(() => {});
        }
        sessionStore.delete(interaction.user.id);
        return;
      }
      // Load admin roles to detect if targets are admins
      const adminRoles = loadAdminRoles();
      const owners = context.BOT_OWNERS || [];
      // Determine if the moderator is a super moderator (owner/responsible)
      const moderatorMember = guild.members.cache.get(interaction.user.id);
      const superModerator = isOwnerOrResponsible(moderatorMember, owners);
      if (!superModerator) {
        // For regular admin role moderators, ensure none of the selected users are admin or owner/responsible
        for (const uid of selectedIds) {
          const targetMember = guild.members.cache.get(uid);
          if (!targetMember) continue;
          if (isOwnerOrResponsible(targetMember, owners) || isAdmin(targetMember, adminRoles)) {
            // Abort and inform the user. Use reply() because no prior response has been sent.
            await interaction.reply({ content: '❌ **لا يمكنك فتح مشكلة ضد عضو يمتلك صلاحيات الإدارة أو مسؤول.**',
              ephemeral: true }).catch(() => {});
            // Cleanup session
            sessionStore.delete(interaction.user.id);
            return;
          }
        }
      }
      session.secondParties = selectedIds;
      session.step = 'reason';
      // Show a modal to enter the reason.  A modal collects a short text.
      const modal = new ModalBuilder()
        .setCustomId('problem_reason_modal')
        .setTitle('سبب المشكلة');
      const reasonInput = new TextInputBuilder()
        .setCustomId('problem_reason_input')
        .setLabel('اذكر السبب بالتفصيل')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(500)
        .setPlaceholder('اكتب سبب المشكلة هنا...')
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      // Display the modal only if interaction is still unacknowledged.
      if (!interaction.replied && !interaction.deferred) {
        await interaction.showModal(modal);
      }
      return;
      } finally {
        session.openingReasonModal = false;
      }
    }
    if (interaction.type === 5 && id === 'problem_reason_modal') {
      // Modal submission: save reason and create problems.
      // Guard against duplicate handling (e.g. duplicated interaction listeners)
      // so the same problem/log is not created twice.
      if (session.creating) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '⏳ **جاري إنشاء البروبلم بالفعل...**', ephemeral: true }).catch(() => {});
        }
        return;
      }

      session.creating = true;
      try {
        const reason = interaction.fields.getTextInputValue('problem_reason_input');
        session.reason = reason;
        await createProblems(interaction, session, context);
        // Remove session after creation
        sessionStore.delete(interaction.user.id);
      } finally {
        session.creating = false;
      }
      return;
    }
  } catch (err) {
    console.error('Error handling problem interaction:', err);
    try {
      // On error, reply with a generic error message
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ **حدث خطأ أثناء معالجة التفاعل!**', ephemeral: true });
      } else {
        await interaction.followUp({ content: '❌ **حدث خطأ أثناء معالجة التفاعل!**', ephemeral: true });
      }
    } catch (e) {
      // ignore secondary errors
    }
  }
}

// Create problem entries for all combinations of first and second parties.  A
// problem entry stores metadata and sets up DM notifications and logs.
async function createProblems(interaction, session, context) {
  const { client } = context;
  const owners = context.BOT_OWNERS || [];
  const guild = client.guilds.cache.get(session.guildId);
  if (!guild) {
    await interaction.reply({ content: '❌ **حدث خطأ: لا يمكن العثور على السيرفر.**', ephemeral: true });
    return;
  }
  const config = session.config || loadProblemConfig();
  let logsChannel = null;
  if (config.logsChannelId) {
    logsChannel = await getLogsChannel(guild, config.logsChannelId);
  }
  const muteRoleId = config.muteRoleId;
  const timestamp = Date.now();
  const isMultiParty = session.firstParties.length > 1 || session.secondParties.length > 1;
  let createdProblemsCount = 0;

  // Iterate through each combination of selected first and second parties.
  for (const firstId of session.firstParties) {
    for (const secondId of session.secondParties) {
      if (firstId === secondId) continue; // skip same user
      const key = getProblemKey(firstId, secondId, guild.id);
      const legacyKey = getProblemKey(firstId, secondId);
      const alreadyExists = activeProblems.has(key) || activeProblems.has(legacyKey);

      // Do not overwrite an existing problem between the same parties within the same guild.
      if (alreadyExists) {
        continue;
      }

      createdProblemsCount += 1;
      activeProblems.set(key, {
        firstId,
        secondId,
        moderatorId: session.moderatorId,
        reason: session.reason,
        timestamp,
        // Store the guild ID so that scheduled tasks can look up the guild and logs channel
        guildId: guild.id,
        // Record when warnings were last reset; initialise to the creation timestamp
        lastWarningReset: timestamp,
        warnings: {},
        responses: {}, // track if each party has responded once; first response is not deleted
        removedAdminRoles: {}, // track roles removed from users due to Administrator permission
        removedSendRoles: {}, // track roles removed that grant SendMessages in a channel
        removedSendOverrides: {}, // track channel overrides applied to deny SendMessages
        locks: {}, // track voice locks per channel
        voiceWarned: {}, // track if DM has been sent to each user for voice violation
        // Track the ID of the log message in the logs channel associated with this problem.
        // This allows us to update the same embed for subsequent events rather than
        // sending a new message every time.
        logMessageId: null
      });
      // Persist new problem to disk
      saveActiveProblemsToDisk();

      // Send DM notifications only for newly-created problems
      try {
        const firstUser = await client.users.fetch(firstId);
        const description = [
          '**تم تسجيل بروبلم**',
          `**الطرف الآخر : <@${secondId}>**`,
          `**السبب : ${session.reason}**`,
          `**المسؤول : <@${session.moderatorId}>**`,
          '**يرجى عدم التواصل مع الطرف الآخر حتى انتهاء المشكلة.**'
        ].join('\n');
        await firstUser.send({
          embeds: [buildProblemEmbed('Problem Notice', description, firstUser.displayAvatarURL?.({ dynamic: true }))]
        });
      } catch (err) {
        console.error('Failed to DM first party:', err);
      }
      try {
        const secondUser = await client.users.fetch(secondId);
        const description = [
          '**تم تسجيل بروبلم**',
          `**الطرف الآخر : <@${firstId}>**`,
          `**السبب : ${session.reason}**`,
          `**المسؤول : <@${session.moderatorId}>**`,
          '**يرجى عدم التواصل مع الطرف الآخر حتى انتهاء المشكلة.**'
        ].join('\n');
        await secondUser.send({
          embeds: [buildProblemEmbed('Problem Notice', description, secondUser.displayAvatarURL?.({ dynamic: true }))]
        });
      } catch (err) {
        console.error('Failed to DM second party:', err);
      }

      // Post log to logs channel if defined (single pair mode)
      if (logsChannel && !isMultiParty) {
        const moderatorAvatar = interaction.user?.displayAvatarURL?.({ dynamic: true }) || null;
        const logEmbed = colorManager.createEmbed()
          .setTitle('New problem')
          .setDescription(
            `**المسؤول : <@${session.moderatorId}>
 الطرف الأول : <@${firstId}>
 الطرف الثاني : <@${secondId}>

 السبب : ${session.reason}**`
          )
          .setTimestamp();
        if (moderatorAvatar) {
          logEmbed.setThumbnail(moderatorAvatar);
        }
        const files = getSeparatorAttachments();
        logsChannel.send({ content: '@here', embeds: [logEmbed] }).catch(() => {});
        if (files && files.length > 0) {
          logsChannel.send({ files }).catch(() => {});
        }
      }
    }
  }

  // If multiple parties are involved, send one combined log embed only if
  // at least one new problem was created.
  if (logsChannel && isMultiParty && createdProblemsCount > 0) {
    const moderatorAvatar = interaction.user?.displayAvatarURL?.({ dynamic: true }) || null;
    const firstPartiesText = session.firstParties.map((id) => `<@${id}>`).join('\n');
    const secondPartiesText = session.secondParties.map((id) => `<@${id}>`).join('\n');
    const logEmbed = colorManager.createEmbed()
      .setTitle(' New problem ')
      .setDescription(
        `**المسؤول : <@${session.moderatorId}>
 الطرف الأول :
${firstPartiesText}
 الطرف الثاني :
${secondPartiesText}

 السبب : ${session.reason}**`
      )
      .setTimestamp();
    if (moderatorAvatar) {
      logEmbed.setThumbnail(moderatorAvatar);
    }
    const files = getSeparatorAttachments();
    logsChannel.send({ content: '@here', embeds: [logEmbed] }).catch(() => {});
    if (files && files.length > 0) {
      logsChannel.send({ files }).catch(() => {});
    }
  }

  // Acknowledge to the moderator
  try {
    if (createdProblemsCount === 0) {
      await interaction.reply({ content: '⚠️ **البروبلم موجود مسبقًا بين نفس الأطراف، لم يتم إنشاء مشكلة جديدة.**', ephemeral: true });
    } else {
      await interaction.reply({ content: '✅ **تم إنشاء البروبلم بنجاح. سيتم مراقبة التفاعل بين الأطراف.**', ephemeral: true });
    }
  } catch (_) {}
}

// Message handler: delete messages where one party responds to the other in
// an active problem.  Send warnings and mute if repeated.  Log actions to
// the logs channel defined in config.
async function handleMessage(message, client) {
  // Store the client reference so that scheduled tasks can access guilds
  if (client) lastClient = client;
  // Ignore messages from bots or in DMs
  if (!message.guild || message.author.bot) return;
  // Iterate over active problems
  for (const [key, prob] of activeProblems.entries()) {
    if (prob.guildId && prob.guildId !== message.guild.id) continue;
    const { firstId, secondId, moderatorId, reason, timestamp } = prob;
    // Check if author is one of the parties
         if (message.author.id === firstId || message.author.id === secondId) {
           // Before processing the message, ensure any roles previously removed for this user have not been re-added
           try {
             const userId = message.author.id;
             const member = await message.guild.members.fetch(userId).catch(() => null);
             if (member) {
               // Remove any roles that were removed due to SendMessages permission but have been re-added
               const removedSendRoles = prob.removedSendRoles && prob.removedSendRoles[userId];
               if (removedSendRoles && removedSendRoles.length > 0) {
                 const regainedSend = removedSendRoles.filter((r) => member.roles.cache.has(r));
                 if (regainedSend.length > 0) {
                   try {
                     await member.roles.remove(regainedSend);
                   } catch (err) {
                     console.error('Failed to remove re-added send roles in handleMessage:', err);
                   }
                 }
               }
               // Remove any roles that were removed due to Administrator permission but have been re-added
               const removedAdminRoles = prob.removedAdminRoles && prob.removedAdminRoles[userId];
               if (removedAdminRoles && removedAdminRoles.length > 0) {
                 const regainedAdmin = removedAdminRoles.filter((r) => member.roles.cache.has(r));
                 if (regainedAdmin.length > 0) {
                   try {
                     await member.roles.remove(regainedAdmin);
                   } catch (err) {
                     console.error('Failed to remove re-added admin roles in handleMessage:', err);
                   }
                 }
               }
             }
             // Reapply channel overrides if they were removed: ensure SendMessages is denied on this channel.
             // However, skip reapplying for channels less than one hour old (likely ticket channels).
             const removedOverrides = prob.removedSendOverrides && prob.removedSendOverrides[userId];
             if (removedOverrides && removedOverrides.includes(message.channel.id)) {
               try {
                 // Only enforce reapplication if the channel is older than one hour
                 const now = Date.now();
                 const createdTs = message.channel.createdTimestamp;
                 const ageMs = createdTs ? (now - createdTs) : Number.MAX_SAFE_INTEGER;
                 const oneHourMs = 60 * 60 * 1000;
                 if (ageMs >= oneHourMs) {
                   const perms = message.channel.permissionsFor(message.member);
                   if (perms && perms.has(PermissionsBitField.Flags.SendMessages)) {
                     await message.channel.permissionOverwrites.edit(message.member.id, { SendMessages: false });
                   }
                 }
               } catch (err) {
                 console.error('Failed to reapply send-message override in handleMessage:', err);
               }
             }
           } catch (err) {
             console.error('Error ensuring removed roles are not re-added:', err);
           }
      // Identify the other party
      const otherId = message.author.id === firstId ? secondId : firstId;
      // Check if the message is directed at the other party: either
      // mentions them or is a reply to one of their messages.
      const mentionsOther = message.mentions.users.has(otherId);
      const replyToOther = message.reference?.messageId
        ? (await message.channel.messages.fetch(message.reference.messageId).catch(() => null))?.author?.id === otherId
        : false;
      if (mentionsOther || replyToOther) {
        // Determine if this is the first response from this user in this problem
        const hasRespondedBefore = !!prob.responses[message.author.id];
        const config = loadProblemConfig();
        const logsChannel = config.logsChannelId
          ? await getLogsChannel(message.guild, config.logsChannelId)
          : null;
        // Determine if the message author has a role that is higher or equal to the bot's highest role.
        let hasHighRole = false;
        let member = null;
        try {
          member = await message.guild.members.fetch(message.author.id).catch(() => null);
          const botMember = message.guild.members.me || (client.user ? await message.guild.members.fetch(client.user.id).catch(() => null) : null);
          if (member && botMember) {
            try {
              // Treat a user as high role only if their highest role position is equal to or above
              // the bot's highest role. Administrator permission alone does not block role management
              // when the bot outranks the member.
              hasHighRole = member.roles.highest.comparePositionTo(botMember.roles.highest) >= 0;
            } catch (_) {
              hasHighRole = false;
            }
          }
        } catch (_) {
          hasHighRole = false;
        }
        const owners = getProblemOwners(client);
        const isOwnerResponsible = member ? isOwnerOrResponsible(member, owners) : false;
        const isAdminRole = member ? member.permissions.has(PermissionsBitField.Flags.Administrator) : false;
        // Build the log embed.  Use a different title depending on whether the
        // message will be deleted or kept.  Include the link only when it still exists.
        const title = hasRespondedBefore ? 'تم حذف رسالة بسبب بروبلم' : 'تم رصد رسالة أثناء بروبلم';
        const messageContent = message.content || '—';
        const messageUrl = message.url;
        // Delete repeated violations immediately to speed up cleanup.
        let deletedMessage = false;
        if (hasRespondedBefore) {
          try {
            await message.delete();
            deletedMessage = true;
          } catch (err) {
            console.error('Failed to delete violating message:', err);
          }
        }
        const desc = deletedMessage
          ? `**الطرف : <@${message.author.id}> رد على الطرف الآخر : <@${otherId}>\nالمحتوى : ${messageContent}**`
          : `**الطرف : <@${message.author.id}> رد على الطرف الآخر : <@${otherId}>\nالمحتوى : ${messageContent}**\n[رابط الرسالة](${messageUrl})`;
        // Calculate the next warning count (used for non-high-role users)
        const nextWarningCount = hasRespondedBefore
          ? ((prob.warnings[message.author.id] || 1) + 1)
          : 1;
        // Determine status: if user has a high role, skip mute and role removal and
        // reflect that in the status; otherwise behave as usual (mute on second violation).
        let status;
        if (hasHighRole) {
          // For high role users, always treat as a warning; second violation still results
          // in message deletion but not a mute.  Reflect deletion status.
          status = hasRespondedBefore ? 'تم حذف الرسالة (رول ستريشن)' : 'تحذير';
        } else {
          status = nextWarningCount > 1 ? 'تم إعطاء ميوت' : 'تحذير';
        }
        const logEmbed = colorManager
          .createEmbed()
          .setTitle(title)
          .setDescription(desc)
          .addFields({ name: 'الحالة', value: status })
          .setTimestamp();
        const authorAvatar = message.author.displayAvatarURL({ dynamic: true });
        const logThumbnail = authorAvatar || LOG_THUMBNAIL_URL;
        if (logThumbnail) {
          logEmbed.setThumbnail(logThumbnail);
        }
        const files = getSeparatorAttachments();
        // Update or send the problem log message
        await updateProblemLog(prob, logEmbed, files);
        // Send warnings via DM.  For high-role users that cannot be muted, enforce a cooldown
        // to avoid spamming the author or the other party with repeated warnings.
        const highRoleWarningCooldownMs = 10 * 60 * 1000;
        const nowMs = Date.now();
        const canSendHighRoleWarning = (bucket, userId) => {
          if (!bucket[userId]) return true;
          return (nowMs - bucket[userId]) >= highRoleWarningCooldownMs;
        };
        const markHighRoleWarning = (bucket, userId) => {
          bucket[userId] = nowMs;
        };
        if (!prob.highRoleWarningAt) prob.highRoleWarningAt = {};
        try {
          // Only DM the author if they are not high-role, or if the cooldown allows it.
          let shouldDmAuthor = !hasHighRole || nextWarningCount <= 1;
          if (hasHighRole && nextWarningCount > 1) {
            shouldDmAuthor = canSendHighRoleWarning(prob.highRoleWarningAt, message.author.id);
          }
          if (shouldDmAuthor) {
            const description = [
              '**لا يُسمح لك بالرد على الطرف الآخر في الوقت الحالي.**',
              '*إذا رديت مجددًا سيتم سحب رولك وإعطائك ميوت.*'
            ].join('\n');
            await message.author.send({
              embeds: [buildProblemEmbed('Problem Warning', description, message.author.displayAvatarURL({ dynamic: true }))]
            });
            if (hasHighRole && nextWarningCount > 1) {
              markHighRoleWarning(prob.highRoleWarningAt, message.author.id);
              saveActiveProblemsToDisk();
            }
          }
        } catch (_) {}
        const shouldDelayOtherMuteNotice = !hasHighRole && nextWarningCount > 1;
        const sendOtherWarning = async (description) => {
          try {
            const other = await client.users.fetch(otherId);
            const shouldDmOther = !hasHighRole || canSendHighRoleWarning(prob.highRoleWarningAt, otherId);
            if (!shouldDmOther) return;
            await other.send({
              embeds: [buildProblemEmbed('Problem Warning', description, other.displayAvatarURL({ dynamic: true }))]
            });
            if (hasHighRole) {
              markHighRoleWarning(prob.highRoleWarningAt, otherId);
              saveActiveProblemsToDisk();
            }
          } catch (_) {}
        };
        if (!shouldDelayOtherMuteNotice) {
          await sendOtherWarning([
            `**الطرف الذي رد : <@${message.author.id}>**`,
            '**لا تقم بالرد على الطرف الآخر في الوقت الحالي.**',
            '*إذا رديت مجددًا سيتم سحب رولك وإعطائك ميوت.*'
          ].join('\n'));
        }
        // If the user has a high role relative to the bot, notify bot owners about this interaction.
        if (hasHighRole) {
          if (!prob.ownerHighRoleNotified) prob.ownerHighRoleNotified = {};
          if (prob.ownerHighRoleNotified[message.author.id]) {
            // Already notified owners for this high-role user in this problem.
          } else {
            for (const ownerId of owners) {
              // Skip notifying the user themselves if they happen to be an owner
              if (ownerId === message.author.id) continue;
              try {
                const ownerUser = await client.users.fetch(ownerId).catch(() => null);
                if (ownerUser) {
                  const ownerFooter = deletedMessage
                    ? `*المحتوى : ${messageContent}*`
                    : `*رابط الرسالة : ${messageUrl}*`;
                  const ownerDescription = [
                    `**⚠️ العضو <@${message.author.id}> رد على <@${otherId}> في مشكلة، ولكن لا يمكن إعطاؤه ميوت أو سحب رتبه لأنه يمتلك رتبة مساوية أو أعلى من البوت.**`,
                    ownerFooter
                  ].join('\n');
                  await ownerUser.send({
                    embeds: [
                      buildProblemEmbed('Problem Warning', ownerDescription, message.author.displayAvatarURL({ dynamic: true }))
                    ]
                  });
                }
              } catch (_) {
                // Ignore DM errors
              }
            }
            prob.ownerHighRoleNotified[message.author.id] = true;
            saveActiveProblemsToDisk();
          }
        }
        // Notify bot owners when an admin-role member (not owner/responsible) responds in a problem.
        if (!hasHighRole && isAdminRole && !isOwnerResponsible) {
          try {
            if (!prob.adminOwnerNotified) prob.adminOwnerNotified = {};
            if (!prob.adminOwnerNotified[message.author.id]) {
              for (const ownerId of owners) {
                if (ownerId === message.author.id) continue;
                try {
                  const ownerUser = await client.users.fetch(ownerId).catch(() => null);
                  if (ownerUser) {
                    const adminDescription = [
                      `**⚠️ العضو <@${message.author.id}> (رتبة إدارية) رد على <@${otherId}> في بروبلم.**`,
                      `*رابط الرسالة : ${message.url}*`
                    ].join('\n');
                    await ownerUser.send({
                      embeds: [
                        buildProblemEmbed('Problem Warning', adminDescription, message.author.displayAvatarURL({ dynamic: true }))
                      ]
                    });
                  }
                } catch (_) {}
              }
              prob.adminOwnerNotified[message.author.id] = true;
              saveActiveProblemsToDisk();
            }
          } catch (_) {}
        }
        // Update response tracking and warnings
        if (!hasRespondedBefore) {
          // Mark that this user has responded once; do not delete the message
          prob.responses[message.author.id] = true;
          // Initialize warning count to 1 so that the next violation triggers deletion
          prob.warnings[message.author.id] = 1;
          // Persist updated active problems to disk so state survives restarts
          saveActiveProblemsToDisk();
        } else {
          // Increment warning count
          prob.warnings[message.author.id] = (prob.warnings[message.author.id] || 1) + 1;
          // If warnings exceed 1 (i.e., this is at least the second violation)
          if (prob.warnings[message.author.id] > 1) {
            // Only apply mute and role removal for users without high roles
            if (!hasHighRole) {
              const member = await message.guild.members.fetch(message.author.id).catch(() => null);
              let muteApplied = false;
              if (member) {
                // Determine whether this is a repeated violation (third or further) and thus warrant strict role removal.
                // We treat warnings > 1 as repeated violation; the first violation sets warning count to 1,
                // the second increments to 2.  Strict mode engages on violations beyond the first.
                // Engage strict mode only on the third or subsequent violations.  The first violation sets
                // warnings to 1, the second sets to 2 and applies a normal mute.  If the user violates
                // again (warnings > 2), strict mode removes all SendMessages roles regardless of name length.
                const strictMode = (prob.warnings[message.author.id] || 0) > 2;
                // Apply the mute.  When strictMode is true, all roles granting SendMessages will be removed
                // regardless of their name length.  In non-strict mode only very short roles are removed.
                const applied = await applyMute(member, prob, message.author.id, message.channel, strictMode);
                muteApplied = !!applied;
                // After applying mute, send the user a DM explaining that they have been muted for replying to the other party.
                try {
                  const dmUser = await client.users.fetch(message.author.id);
                  const cfg2 = loadProblemConfig();
                  const muteDurationMs = cfg2.muteDuration || (10 * 60 * 1000);
                  const muteDurationMinutes = Math.floor(muteDurationMs / 60000);
                  const description = [
                    `**🚫 تم إعطاؤك ميوت لمدة ${muteDurationMinutes} دقيقة بسبب ردك على الطرف الآخر فى البروبلم.**`,
                    '*سيتم إعادة أى رتب تمت إزالتها تلقائيًا بعد انتهاء مدة الميوت. لا تقم بالرد مجددًا حتى ينتهى الميوت.*'
                  ].join('\n');
                  await dmUser.send({
                    embeds: [buildProblemEmbed('Problem Mute', description, dmUser.displayAvatarURL({ dynamic: true }))]
                  });
                } catch (err) {
                  console.error('Failed to DM user about applied mute:', err);
                }
              }
              if (shouldDelayOtherMuteNotice) {
                const otherDescription = muteApplied
                  ? [
                      `**الطرف الذي رد : <@${message.author.id}>**`,
                      '**تم إعطاء الطرف الآخر ميوت بسبب البروبلم.**',
                      '*لا تحتاج ترد عليه، وإذا رديت بتاخذ ميوت معه.*'
                    ].join('\n')
                  : [
                      `**الطرف الذي رد : <@${message.author.id}>**`,
                      '**لا تقم بالرد على الطرف الآخر في الوقت الحالي.**',
                      '*إذا رديت مجددًا سيتم سحب رولك وإعطائك ميوت.*'
                    ].join('\n');
                await sendOtherWarning(otherDescription);
              }
            }
          }
          // Persist updated active problems after incrementing warnings
          saveActiveProblemsToDisk();
        }
        // We handled this message, break out of problem loop
        break;
      }
    }
  }
}

// Voice handler: if a user enters a voice channel where the other party is
// present, disconnect them and temporarily deny Connect permission.
async function handleVoice(oldState, newState, client) {
  // Store the client reference for use in scheduled tasks
  if (client) lastClient = client;
  // newState.member: the user whose state changed
  if (!newState || !newState.member || newState.member.user.bot) return;
  const userId = newState.member.id;
  const guild = newState.guild;
  const newChannel = newState.channel;
  if (!newChannel) return; // user left or not joined
  if (newChannel.type === ChannelType.GuildStageVoice) return;
  // Check if there is an active problem involving this user
  for (const [key, prob] of activeProblems.entries()) {
    if (prob.guildId && prob.guildId !== newState.guild.id) continue;
    const { firstId, secondId } = prob;
    if (userId === firstId || userId === secondId) {
      // Identify the other user
      const otherId = userId === firstId ? secondId : firstId;
      // Check if the other user is currently in the same voice channel
      const otherMember = guild.members.cache.get(otherId);
      if (otherMember && otherMember.voice.channelId === newChannel.id) {
        // Determine if the entering member has a role equal or higher than the bot.  If so,
        // we avoid applying Connect restrictions or admin role removal.  Instead, we simply
        // disconnect them each time and notify the bot owners once.  We also log only once
        // to avoid spam in the logs channel.
        let hasHighRole = false;
        try {
          const botMember = guild.members.me || (client.user ? await guild.members.fetch(client.user.id).catch(() => null) : null);
          const member = newState.member;
          if (member && botMember) {
            // Consider high role only when the member's highest role is equal to or above the bot.
            hasHighRole = member.roles.highest.comparePositionTo(botMember.roles.highest) >= 0;
          }
        } catch (_) {
          hasHighRole = false;
        }
        // Always disconnect the user immediately
        try {
          await newState.disconnect();
        } catch (err) {
          // fallback: move to null channel
          try {
            await newState.member.voice.setChannel(null);
          } catch (_) {}
        }
        // If the user has a high role, skip muting logic and just DM/log once
        if (hasHighRole) {
          // Send a DM to the user on first voice violation.  Use a separate flag
          // for high-role voice warnings to avoid spamming.  The flag is stored on
          // prob.voiceWarnedHigh keyed by userId.
          try {
            if (!prob.voiceWarnedHigh) prob.voiceWarnedHigh = {};
            if (!prob.voiceWarnedHigh[userId]) {
              const dmUser = await client.users.fetch(userId);
              const problemTime = new Date(prob.timestamp).toLocaleString('en-US', { timeZone: 'Africa/Cairo' });
              const description = [
                '**⚠️ يوجد شخص في الروم بينك وبينه بروبلم.**',
                `**الشخص : <@${otherId}>**`,
                `**وقت البروبلم كان : ${problemTime}**`,
                `**المسؤول كان : <@${prob.moderatorId}>**`,
                '**إذا دخلت مجددًا سيتم طردك تلقائيًا.**'
              ].join('\n');
              await dmUser.send({
                embeds: [buildProblemEmbed('Voice Problem Warning', description, dmUser.displayAvatarURL({ dynamic: true }))]
              });
              prob.voiceWarnedHigh[userId] = true;
              saveActiveProblemsToDisk();
            }
          } catch (err) {
            console.error('Failed to DM high-role user about voice violation:', err);
          }
          // Notify bot owners (once per high-role voice violation) that this user
          // cannot be muted due to role hierarchy.  Use a per-user flag prob.voiceOwnerNotified
          // to avoid repeating notifications.
          try {
            if (!prob.voiceOwnerNotified) prob.voiceOwnerNotified = {};
            if (!prob.voiceOwnerNotified[userId]) {
          const owners = getProblemOwners(client);
              for (const ownerId of owners) {
                if (ownerId === userId) continue;
                try {
                  const ownerUser = await client.users.fetch(ownerId).catch(() => null);
                  if (ownerUser) {
                    const ownerDescription = `**⚠️ العضو <@${userId}> دخل روم صوتي مع <@${otherId}> في مشكلة، ولكن لا يمكن سحب صلاحياته أو منعه بسبب امتلاكه رتبة مساوية أو أعلى من البوت.**`;
                    await ownerUser.send({
                      embeds: [
                        buildProblemEmbed('Voice Problem Warning', ownerDescription, newState.member.displayAvatarURL({ dynamic: true }))
                      ]
                    });
                  }
                } catch (_) {}
              }
              prob.voiceOwnerNotified[userId] = true;
              saveActiveProblemsToDisk();
            }
          } catch (err) {
            console.error('Failed to notify owners about high-role voice violation:', err);
          }
          // Log only once per user for high-role voice violations.  Use prob.voiceLoggedHigh
          try {
            const config = loadProblemConfig();
            const logsChannelId = config.logsChannelId;
            if (logsChannelId) {
              if (!prob.voiceLoggedHigh) prob.voiceLoggedHigh = {};
              if (!prob.voiceLoggedHigh[userId]) {
                const logsChannel = await getLogsChannel(guild, logsChannelId);
                if (logsChannel) {
                  const logEmbed = colorManager
                    .createEmbed()
                    .setTitle('دخول مخالف لروم صوتي')
                    .setDescription(
                      `**العضو : <@${userId}> دخل روم صوتي مع الطرف الاخر : <@${otherId}>\nتم طرده تلقائيًا، لكن لم يتم منعه من الاتصال بسبب امتلاكه رتبة مساوية أو أعلى من البوت.**`
                    )
                    .addFields({ name: 'الحالة', value: 'تم الطرد (رول ستريشن)' })
                    .setTimestamp();
                  const voiceAvatar = newState.member?.displayAvatarURL?.({ dynamic: true });
                  if (voiceAvatar) {
                    logEmbed.setThumbnail(voiceAvatar);
                  }
                  const files = getSeparatorAttachments();
                  await updateProblemLog(prob, logEmbed, files);
                }
                prob.voiceLoggedHigh[userId] = true;
                saveActiveProblemsToDisk();
              }
            }
          } catch (err) {
            console.error('Failed to log high-role voice violation:', err);
          }
          // Skip the rest of the mute logic for high-role users.  Only handle this one problem
          break;
        }
        // If not high role, proceed with the normal voice handling: deny Connect for duration,
        // schedule restoration, and potentially remove admin roles on re-entry.
        // Deny Connect permission for this channel for a duration
        const config = loadProblemConfig();
        const duration = config.muteDuration || 10 * 60 * 1000;
        const lockKey = `${newChannel.id}:${userId}`;
        // If not already locked or expired
        const existingLock = channelLocks.get(lockKey);
        if (!existingLock || existingLock.expiresAt <= Date.now()) {
          // Add permission overwrite
          try {
            await newChannel.permissionOverwrites.edit(userId, { Connect: false });
          } catch (err) {
            console.error('Failed to set Connect false on channel:', err);
          }
          const expiresAt = Date.now() + duration;
          channelLocks.set(lockKey, { guildId: guild.id, expiresAt });
          // Send a DM to the offending user on first voice violation.  Include details
          // about the other party, problem creation time and responsible moderator.
          try {
            if (!prob.voiceWarned) prob.voiceWarned = {};
            if (!prob.voiceWarned[userId]) {
              const dmUser = await client.users.fetch(userId);
              // Format the problem timestamp for Cairo timezone (24h).  Fallback to
              // server locale if specific locale is not available.
              const problemTime = new Date(prob.timestamp).toLocaleString('en-US', { timeZone: 'Africa/Cairo' });
              const description = [
                '**⚠️ يوجد شخص في الروم بينك وبينه بروبلم.**',
                `**الشخص : <@${otherId}>**`,
                `**وقت البروبلم كان : ${problemTime}**`,
                `**المسؤول كان : <@${prob.moderatorId}>**`,
                '**إذا دخلت مجددًا سيتم سحب رولك مؤقتًا.**'
              ].join('\n');
              await dmUser.send({
                embeds: [buildProblemEmbed('Voice Problem Warning', description, dmUser.displayAvatarURL({ dynamic: true }))]
              });
              prob.voiceWarned[userId] = true;
              // Persist the updated state to disk
              saveActiveProblemsToDisk();
            }
          } catch (err) {
            console.error('Failed to DM user about voice violation:', err);
          }
          // Notify bot owners if an admin-role member (not owner/responsible) violates voice rules.
          try {
            const adminRoles = loadAdminRoles();
            const owners = getProblemOwners(client);
            const isOwnerResponsible = isOwnerOrResponsible(newState.member, owners);
            const isAdminRole = isAdmin(newState.member, adminRoles);
            if (isAdminRole && !isOwnerResponsible) {
              if (!prob.adminVoiceOwnerNotified) prob.adminVoiceOwnerNotified = {};
              if (!prob.adminVoiceOwnerNotified[userId]) {
                for (const ownerId of owners) {
                  if (ownerId === userId) continue;
                  try {
                    const ownerUser = await client.users.fetch(ownerId).catch(() => null);
                    if (ownerUser) {
                      await ownerUser.send(
                        `**⚠️ العضو <@${userId}> (رتبة إدارية) دخل روم صوتي مع <@${otherId}> أثناء بروبلم.**`
                      );
                    }
                  } catch (_) {}
                }
                prob.adminVoiceOwnerNotified[userId] = true;
                saveActiveProblemsToDisk();
              }
            }
          } catch (_) {}
          // Schedule removal of the Connect restriction and restoration of admin roles when the lock expires
          setTimeout(async () => {
            try {
              // Remove the channel-specific Connect restriction
              const channel = guild.channels.cache.get(newChannel.id);
              if (channel) {
                try {
                  await channel.permissionOverwrites.delete(userId).catch(() => {});
                } catch (_) {}
              }
              // Remove the lock entry
              channelLocks.delete(lockKey);
              // Restore any admin roles removed during voice violations for this user
              if (prob.removedAdminRoles && prob.removedAdminRoles[userId] && prob.removedAdminRoles[userId].length > 0) {
                try {
                  const member = await guild.members.fetch(userId).catch(() => null);
                  if (member) {
                    await member.roles.add(prob.removedAdminRoles[userId]).catch(() => {});
                  }
                } catch (e) {
                  console.error('Failed to restore admin roles after voice lock:', e);
                }
                delete prob.removedAdminRoles[userId];
                saveActiveProblemsToDisk();
              }
            } catch (cleanupErr) {
              console.error('Error cleaning up after voice lock expires:', cleanupErr);
            }
          }, duration);
          // Log the action once per lock
          const logsChannelId = config.logsChannelId;
          if (logsChannelId) {
            const logsChannel = await getLogsChannel(guild, logsChannelId);
            if (logsChannel) {
              const logEmbed = colorManager
                .createEmbed()
                .setTitle('دخول مخالف لروم صوتي')
                .setDescription(
                  `**العضو : <@${userId}> دخل روم صوتي مع الطرف الاخر : <@${otherId}>\nتم منعه من الاتصال في هذا الروم لمدة ${duration / 60000} دقائق وتم طرده تلقائيًا.**`
                )
                .addFields({ name: 'الحالة', value: 'تم الطرد وغلق الروم' })
                .setTimestamp();
              const voiceAvatar = newState.member?.displayAvatarURL?.({ dynamic: true });
              if (voiceAvatar) {
                logEmbed.setThumbnail(voiceAvatar);
              }
              const files = getSeparatorAttachments();
              // Update or send the problem log
              await updateProblemLog(prob, logEmbed, files);
            }
          }
        } else {
          // Already locked: just disconnect again without logging
        }
        // If the user is re-entering while a lock is still active, remove Administrator roles
        const reentryLock = channelLocks.get(lockKey);
        if (reentryLock && reentryLock.expiresAt > Date.now()) {
          const member = newState.member;
          if (member && member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            await removeAdminRolesForVoice(member, prob);
            // Log re-entry: user attempted to join the voice channel again while locked
            // and had their Administrator roles removed.  Include a status field to
            // indicate the current action.
            try {
              const reentryConfig = loadProblemConfig();
              const logsChanId = reentryConfig.logsChannelId;
              if (logsChanId) {
                const logsChannel = await getLogsChannel(guild, logsChanId);
                if (logsChannel) {
                  const reentryEmbed = colorManager
                    .createEmbed()
                    .setTitle('دخول مخالف لروم صوتي')
                    .setDescription(
                      `**العضو : <@${userId}> دخل روم صوتي مع الطرف الاخر : <@${otherId}>\nتم سحب صلاحياته مؤقتًا لتكراره الدخول.**`
                    )
                    .addFields({ name: 'الحالة', value: 'تم سحب الصلاحيات مؤقتًا' })
                    .setTimestamp();
                  const voiceAvatar = newState.member?.displayAvatarURL?.({ dynamic: true });
                  if (voiceAvatar) {
                    reentryEmbed.setThumbnail(voiceAvatar);
                  }
                  const files = getSeparatorAttachments();
                  await updateProblemLog(prob, reentryEmbed, files);
                }
              }
            } catch (err) {
              console.error('Failed to log voice re-entry:', err);
            }
          }
        }
        // Only handle first matching problem
        break;
      }
    }
  }
}

// Member update handler: if the mute role is removed manually from a user who is currently muted as part of an active problem,
// re-apply the role unless the removal was performed by a guild owner, an administrator or a responsible role.  This prevents
// regular members from bypassing the mute by manually removing the role.  A log entry is posted to the logs channel when
// unauthorised removal is detected.
async function handleMemberUpdate(oldMember, newMember, client) {
  try {
    const config = loadProblemConfig();
    const muteRoleId = config.muteRoleId;
    if (!muteRoleId) return;
    // Only act if mute role was removed
    const hadMute = oldMember.roles.cache.has(muteRoleId);
    const hasMute = newMember.roles.cache.has(muteRoleId);
    if (hadMute && !hasMute) {
      // Check if the member is involved in any active problem
      let inProblem = false;
      for (const [key, prob] of activeProblems.entries()) {
        if (prob.guildId && prob.guildId !== newMember.guild.id) continue;
        if (prob.firstId === newMember.id || prob.secondId === newMember.id) {
          inProblem = true;
          break;
        }
      }
      if (!inProblem) return;
      const guild = newMember.guild;
      // Fetch recent audit logs to determine who removed the role
      let entry;
      try {
        const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 5 });
        const now = Date.now();
        for (const e of logs.entries.values()) {
          if (e.target.id === newMember.id && (now - e.createdTimestamp) < 5000) {
            // Find change where the mute role was removed
            const removed = e.changes.find((ch) => ch.key === '$remove' && Array.isArray(ch.new) && ch.new.some((r) => r.id === muteRoleId));
            if (removed) {
              entry = e;
              break;
            }
          }
        }
      } catch (err) {
        // ignore errors
      }
      let authorized = false;
      let executorMember = null;
      if (entry && entry.executor) {
        try {
          executorMember = await guild.members.fetch(entry.executor.id);
        } catch (_) {
          executorMember = null;
        }
        if (executorMember) {
          const BOT_OWNERS = loadBotOwners();
          // Authorised if guild owner
          if (executorMember.id === guild.ownerId) authorized = true;
          // Authorised if the bot removed the mute (scheduled expiry or command action)
          else if (client?.user?.id && executorMember.id === client.user.id) authorized = true;
          // Authorised if bot owner
          else if (BOT_OWNERS.includes(executorMember.id)) authorized = true;
        }
      }
         if (!authorized) {
        // Re-apply the mute role
        try {
          await newMember.roles.add(muteRoleId);
        } catch (err) {
          console.error('Failed to re-add mute role after unauthorised removal:', err);
        }
        // Log the attempt in logs channel only once per user to prevent spam
        if (!muteRemovalWarned.has(newMember.id)) {
          muteRemovalWarned.add(newMember.id);
          if (config.logsChannelId) {
            const logsChannel = await getLogsChannel(guild, config.logsChannelId);
            if (logsChannel) {
              const executorMention = executorMember ? `<@${executorMember.id}>` : 'شخص مجهول';
              const logEmbed = colorManager.createEmbed()
                .setTitle('Remove Mute')               .setDescription(`**${executorMention} حاول إزالة رول الميوت من <@${newMember.id}> يدويًا وتمت إعادة تطبيقه.**`)
                .setTimestamp();
              const executorAvatar = executorMember?.displayAvatarURL?.({ dynamic: true });
              const targetAvatar = newMember.user?.displayAvatarURL?.({ dynamic: true });
              if (executorAvatar || targetAvatar) {
                logEmbed.setThumbnail(executorAvatar || targetAvatar);
              }
              const files = getSeparatorAttachments();
              // Send the main log embed first without the separator image
              logsChannel.send({ embeds: [logEmbed] }).catch(() => {});
              // Then send the separator image as a separate message if present
              if (files && files.length > 0) {
                logsChannel.send({ files }).catch(() => {});
              }
            }
          }
        }
        // After handling mute role removals, check if any roles that were removed due to a problem were re-added
        try {
          // Iterate over all active problems to find if this member is involved
          for (const [pkey, prob] of activeProblems.entries()) {
            if (prob.firstId !== newMember.id && prob.secondId !== newMember.id) {
              continue;
            }
            const guild = newMember.guild;
            // Check admin roles re-added
            const removedAdmin = prob.removedAdminRoles && prob.removedAdminRoles[newMember.id];
            const regainedAdmin = [];
            if (removedAdmin && removedAdmin.length > 0) {
              for (const roleId of removedAdmin) {
                if (newMember.roles.cache.has(roleId) && !oldMember.roles.cache.has(roleId)) {
                  regainedAdmin.push(roleId);
                }
              }
              if (regainedAdmin.length > 0) {
                // Remove the roles again
                try {
                  await newMember.roles.remove(regainedAdmin);
                } catch (err) {
                  console.error('Failed to remove re-added admin roles:', err);
                }
              }
            }
            // Check send-message roles re-added
            const removedSend = prob.removedSendRoles && prob.removedSendRoles[newMember.id];
            const regainedSend = [];
            if (removedSend && removedSend.length > 0) {
              for (const roleId of removedSend) {
                if (newMember.roles.cache.has(roleId) && !oldMember.roles.cache.has(roleId)) {
                  regainedSend.push(roleId);
                }
              }
              if (regainedSend.length > 0) {
                try {
                  await newMember.roles.remove(regainedSend);
                } catch (err) {
                  console.error('Failed to remove re-added send roles:', err);
                }
              }

            // Additionally, remove any newly added roles that meet the mute removal criteria.  A
            // newly added role is one that appears in the new member but not in the old member.
            // We remove roles with the Administrator permission regardless of name length,
            // and roles with the SendMessages permission if their effective name length is
            // three characters or fewer.  Removed roles are stored so they can be restored later.
            try {
              const newlyRemovedAdmin = [];
              const newlyRemovedSend = [];
              newMember.roles.cache.forEach((role) => {
                if (!oldMember.roles.cache.has(role.id)) {
                  // Skip managed roles (integrations) that cannot be removed
                  if (!role || role.managed) return;
                  // Administrator roles are always removed
                  if (role.permissions.has(PermissionsBitField.Flags.Administrator)) {
                    newlyRemovedAdmin.push(role.id);
                  } else if (role.permissions.has(PermissionsBitField.Flags.SendMessages)) {
                    // Determine if this problem is in strict mode for this user.  When strict
                    // mode is active, all SendMessages roles are removed regardless of name length.
                    const isStrict = prob.strictMode && prob.strictMode[newMember.id];
                    if (isStrict) {
                      newlyRemovedSend.push(role.id);
                    } else {
                      const eff = getEffectiveRoleNameLength(role.name || '');
                      if (eff <= 3) {
                        newlyRemovedSend.push(role.id);
                      }
                    }
                  }
                }
              });
              // Remove newly added Administrator roles and record them
              if (newlyRemovedAdmin.length > 0) {
                if (!prob.removedAdminRoles) prob.removedAdminRoles = {};
                if (!prob.removedAdminRoles[newMember.id]) prob.removedAdminRoles[newMember.id] = [];
                const newAdminIds = newlyRemovedAdmin.filter((id) => !prob.removedAdminRoles[newMember.id].includes(id));
                if (newAdminIds.length > 0) {
                  prob.removedAdminRoles[newMember.id].push(...newAdminIds);
                  await newMember.roles.remove(newAdminIds).catch(() => {});
                  regainedAdmin.push(...newAdminIds);
                }
              }
              // Remove newly added SendMessages roles with short names and record them
              if (newlyRemovedSend.length > 0) {
                if (!prob.removedSendRoles) prob.removedSendRoles = {};
                if (!prob.removedSendRoles[newMember.id]) prob.removedSendRoles[newMember.id] = [];
                const newSendIds = newlyRemovedSend.filter((id) => !prob.removedSendRoles[newMember.id].includes(id));
                if (newSendIds.length > 0) {
                  prob.removedSendRoles[newMember.id].push(...newSendIds);
                  await newMember.roles.remove(newSendIds).catch(() => {});
                  regainedSend.push(...newSendIds);
                }
              }
            } catch (err) {
              console.error('Error removing newly added roles after mute:', err);
            }
            }
            // If any roles were re-added, log once per user to avoid spam
            if ((regainedAdmin.length > 0 || regainedSend.length > 0) && !roleReaddWarned.has(newMember.id)) {
              roleReaddWarned.add(newMember.id);
              if (config.logsChannelId) {
                const logsChannel = await getLogsChannel(guild, config.logsChannelId);
                if (logsChannel) {
                  // Build description listing the regained roles
                  const allRegained = [...regainedAdmin, ...regainedSend];
                  const roleMentions = allRegained.map((rid) => {
                    const roleObj = guild.roles.cache.get(rid);
                    return roleObj ? `<@&${roleObj.id}>` : rid;
                  }).join(' ، ');
                  const logEmbed = colorManager.createEmbed()
                    .setTitle('إعادة دور مخالف')
                    .setDescription(
                      `**تمت إعادة دور غير مسموح لـ <@${newMember.id}> (${roleMentions}) وتمت إزالته مرة أخرى تلقائيًا.**`
                    )
                    .setTimestamp();
                  const memberAvatar = newMember.user?.displayAvatarURL?.({ dynamic: true });
                  if (memberAvatar) {
                    logEmbed.setThumbnail(memberAvatar);
                  }
                  const files = getSeparatorAttachments();
                  // Send the main log embed first without the separator image
                  logsChannel.send({ embeds: [logEmbed] }).catch(() => {});
                  // Then send the separator image as a separate message if present
                  if (files && files.length > 0) {
                    logsChannel.send({ files }).catch(() => {});
                  }
                }
              }
            }
          }
        } catch (err) {
          console.error('Error checking for re-added roles:', err);
        }
      }
    }
  } catch (err) {
    console.error('Error in handleMemberUpdate:', err);
  }
}

// Apply mute to a member: temporarily remove admin roles if user has
// Administrator permission, add the configured mute role, and schedule
// restoration after the configured duration.  The prob object is
// updated to remember which admin roles were removed so they can be
// restored later.
// Helper to compute the effective length of a role name.  Special punctuation
// characters such as '-' ':' and '،' are treated as three characters each.
// This function is used to determine whether a role name should be
// considered "short" (≤3 characters) for the purpose of removing SendMessages
// roles when muting a user.
function getEffectiveRoleNameLength(name) {
  let length = 0;
  for (const ch of name) {
    // Treat certain punctuation characters as three characters each.  This helps
    // ensure very short role names (like '-', ':', '،', '؛') are considered
    // longer when calculating whether to remove them.  See applyMute for usage.
    if (ch === '-' || ch === ':' || ch === '،' || ch === '؛') {
      length += 3;
    } else {
      length += 1;
    }
  }
  return length;
}
    /**
     * Apply mute to a guild member.  When a user violates the problem rules
     * repeatedly, a stricter mode can be used to strip all roles that grant
     * the SendMessages permission regardless of their name length.  By default
     * only very short roles (three characters or fewer) are removed to limit
     * collateral damage.  Administrator roles are always removed in either
     * mode.  A channel-specific overwrite denying SendMessages is also
     * applied on the offending channel to catch any remaining permissions.
     *
     * @param {GuildMember} member The guild member to mute.
     * @param {Object} prob The active problem record for this case.
     * @param {string} authorId The ID of the offending user (used as key in prob.removed* maps).
     * @param {GuildChannel} channel The channel where the violation occurred (used for overrides).
     * @param {boolean} strict When true, remove all SendMessages roles regardless of length.
     */
    async function applyMute(member, prob, authorId, channel, strict = false) {
      const guild = member.guild;
      const config = loadProblemConfig();
      const muteRoleId = config.muteRoleId;
      const muteDuration = config.muteDuration || 10 * 60 * 1000;
      // Track whether we applied a mute role
      let muteApplied = false;
      // Compute sets of roles to remove based on Administrator and SendMessages permissions.
      // Any role granting Administrator is removed regardless of its name length.  Roles
      // granting SendMessages are removed only if their effective name length (as computed
      // by getEffectiveRoleNameLength) is three or fewer characters, unless strict mode
      // is enabled.  In strict mode, all roles granting SendMessages are removed
      // regardless of name length.  Punctuation such as '-' ':' '،' and '؛' counts as
      // three characters each for length calculations.
      const rolesToRemoveAdmin = [];
      const rolesToRemoveSend = [];
      for (const role of member.roles.cache.values()) {
        // Skip roles that are managed by integrations or the system
        if (!role || role.managed) continue;
        // Remove any Administrator roles regardless of name length
        if (role.permissions.has(PermissionsBitField.Flags.Administrator)) {
          rolesToRemoveAdmin.push(role.id);
          continue;
        }
        // Remove roles that grant SendMessages
        if (role.permissions.has(PermissionsBitField.Flags.SendMessages)) {
          if (strict) {
            rolesToRemoveSend.push(role.id);
          } else {
            const effLen = getEffectiveRoleNameLength(role.name || '');
            if (effLen <= 3) {
              rolesToRemoveSend.push(role.id);
            }
          }
        }
      }
      // Remove Administrator roles and record them
      if (rolesToRemoveAdmin.length > 0) {
        if (!prob.removedAdminRoles) prob.removedAdminRoles = {};
        if (!prob.removedAdminRoles[authorId]) prob.removedAdminRoles[authorId] = [];
        // Filter out roles already removed previously
        const newAdmin = rolesToRemoveAdmin.filter((id) => !prob.removedAdminRoles[authorId].includes(id));
        if (newAdmin.length > 0) {
          prob.removedAdminRoles[authorId].push(...newAdmin);
          try {
            await member.roles.remove(newAdmin);
          } catch (err) {
            console.error('Failed to remove admin roles:', err);
          }
        }
      }
      // Remove SendMessages roles (short-named or all in strict mode) and record them
      if (rolesToRemoveSend.length > 0) {
        if (!prob.removedSendRoles) prob.removedSendRoles = {};
        if (!prob.removedSendRoles[authorId]) {
          prob.removedSendRoles[authorId] = [];
        }
        // Filter out roles that have already been removed
        const newSend = rolesToRemoveSend.filter((id) => !prob.removedSendRoles[authorId].includes(id));
        if (newSend.length > 0) {
          prob.removedSendRoles[authorId].push(...newSend);
          try {
            await member.roles.remove(newSend);
          } catch (err) {
            console.error('Failed to remove send message roles:', err);
          }
        }
      }

      // Record whether strict mode was applied for this user.  This flag is used by
      // handleMemberUpdate to determine whether future SendMessages roles of any length
      // should be automatically removed when re-added.  When strict mode is not
      // engaged, clear any prior strict flag for the user.
      if (!prob.strictMode) prob.strictMode = {};
      if (strict) {
        prob.strictMode[authorId] = true;
      } else {
        // Remove the flag if it exists, so that subsequent role additions use normal rules
        delete prob.strictMode[authorId];
      }
      // Always apply a channel-specific SendMessages override if a channel is provided to
      // prevent the user from sending messages through roles we could not remove (e.g.
      // long-named roles or newly added roles).  Skip very new channels such as ticket
      // channels to avoid interfering with support channels.
      if (channel) {
        try {
          const now = Date.now();
          const channelAgeMs = channel.createdTimestamp ? now - channel.createdTimestamp : Number.MAX_SAFE_INTEGER;
          const oneHourMs = 60 * 60 * 1000;
          if (channelAgeMs >= oneHourMs) {
            if (!prob.removedSendOverrides) prob.removedSendOverrides = {};
            if (!prob.removedSendOverrides[authorId]) {
              prob.removedSendOverrides[authorId] = [];
            }
            if (!prob.removedSendOverrides[authorId].includes(channel.id)) {
              await channel.permissionOverwrites.edit(member.id, { SendMessages: false });
              prob.removedSendOverrides[authorId].push(channel.id);
            }
          }
        } catch (err) {
          console.error('Failed to apply send message overwrite:', err);
        }
      }
      // Apply mute role if defined
      if (muteRoleId) {
        if (!member.roles.cache.has(muteRoleId)) {
          try {
            await member.roles.add(muteRoleId);
            muteApplied = true;
          } catch (err) {
            console.error('Failed to add mute role:', err);
          }
        }
      }
      // Persist modifications to disk
      saveActiveProblemsToDisk();
      // Schedule restoration of roles, overrides and mute role after the mute duration
      setTimeout(async () => {
        try {
          // Restore admin roles if removed
          const rolesRemovedAdmin = prob.removedAdminRoles && prob.removedAdminRoles[authorId];
          if (rolesRemovedAdmin && rolesRemovedAdmin.length > 0) {
            const freshMember = await guild.members.fetch(authorId).catch(() => null);
            if (freshMember) {
              for (const roleId of rolesRemovedAdmin) {
                if (!freshMember.roles.cache.has(roleId)) {
                  try {
                    await freshMember.roles.add(roleId);
                  } catch (err) {
                    console.error('Failed to restore admin role:', err);
                  }
                }
              }
            }
            delete prob.removedAdminRoles[authorId];
          }
          // Restore roles that granted SendMessages
          const rolesRemovedSend = prob.removedSendRoles && prob.removedSendRoles[authorId];
          if (rolesRemovedSend && rolesRemovedSend.length > 0) {
            const freshMember = await guild.members.fetch(authorId).catch(() => null);
            if (freshMember) {
              for (const roleId of rolesRemovedSend) {
                if (!freshMember.roles.cache.has(roleId)) {
                  try {
                    await freshMember.roles.add(roleId);
                  } catch (err) {
                    console.error('Failed to restore send message role:', err);
                  }
                }
              }
            }
            delete prob.removedSendRoles[authorId];
          }
          // Remove channel overrides that denied SendMessages
          const overrides = prob.removedSendOverrides && prob.removedSendOverrides[authorId];
          if (overrides && overrides.length > 0) {
            for (const chanId of overrides) {
              const ch = guild.channels.cache.get(chanId);
              if (ch) {
                try {
                  // Delete the user-specific overwrite entirely
                  await ch.permissionOverwrites.delete(authorId);
                } catch (err) {
                  console.error('Failed to remove send message overwrite:', err);
                }
              }
            }
            delete prob.removedSendOverrides[authorId];
          }
          // Remove mute role if applied
          if (muteApplied) {
            const freshMember2 = await guild.members.fetch(authorId).catch(() => null);
            if (freshMember2 && freshMember2.roles.cache.has(muteRoleId)) {
              try {
                await freshMember2.roles.remove(muteRoleId);
              } catch (err) {
                console.error('Failed to remove mute role:', err);
              }
            }
          }
          // Persist changes after restoration
          saveActiveProblemsToDisk();
        } catch (err) {
          console.error('Error restoring roles after mute:', err);
        }
      }, muteDuration);
      return muteApplied;
    }

    // Update or create a log message in the logs channel for a problem.
    // This helper updates the existing embed if a log message has already been sent for
    // the given problem; otherwise it sends a new embed and stores the message ID on
    // the problem object.  The separator attachments are passed through to preserve
    // the horizontal line if enabled.  Errors are logged but do not throw.
    const oneDayMs = 24 * 60 * 60 * 1000;
    const isRecentLogMessage = (msg) => {
      if (!msg?.createdTimestamp) return false;
      return (Date.now() - msg.createdTimestamp) < oneDayMs;
    };

    async function findExistingLogMessage(logsChannel, prob, botId) {
      const messages = await logsChannel.messages.fetch({ limit: 20 }).catch(() => null);
      if (!messages) return null;
      for (const msg of messages.values()) {
        if (!msg.author || msg.author.id !== botId) continue;
        if (!isRecentLogMessage(msg)) continue;
        const embed = msg.embeds?.[0];
        const desc = embed?.description || '';
        if (!desc) continue;
        const hasFirst = desc.includes(`<@${prob.firstId}>`);
        const hasSecond = desc.includes(`<@${prob.secondId}>`);
        if (hasFirst && hasSecond) {
          return msg;
        }
      }
      return null;
    }


    async function isMessageInLastTwoBotEmbeds(logsChannel, messageId, botId) {
      if (!messageId || !botId) return false;
      const messages = await logsChannel.messages.fetch({ limit: 20 }).catch(() => null);
      if (!messages) return false;

      const botEmbedMessages = [];
      for (const msg of messages.values()) {
        if (!msg?.author || msg.author.id !== botId) continue;
        if (!msg.embeds || msg.embeds.length === 0) continue;
        botEmbedMessages.push(msg);
      }

      const lastTwoIds = botEmbedMessages.slice(0, 2).map((msg) => msg.id);
      return lastTwoIds.includes(messageId);
    }

    async function updateProblemLog(prob, logEmbed, files = []) {
      try {
        // Ensure we have a client reference and can look up the guild
        const guild = lastClient?.guilds?.cache?.get(prob.guildId);
        if (!guild) return;
        const config = loadProblemConfig();
        const logsChannelId = config.logsChannelId;
        if (!logsChannelId) return;
                const logsChannel = await getLogsChannel(guild, logsChannelId);
        if (!logsChannel) return;
        // If a log message already exists, edit only the embed portion.  Do not resend the
        // separator image on edits to avoid duplicating the line.  The separator should be
        // sent only when the log is first created.
        if (prob.logMessageId) {
          const existingMsg = await logsChannel.messages.fetch(prob.logMessageId).catch(() => null);
          if (existingMsg && isRecentLogMessage(existingMsg)) {
            const canEdit = await isMessageInLastTwoBotEmbeds(logsChannel, existingMsg.id, lastClient?.user?.id);
            if (canEdit) {
              await existingMsg.edit({ embeds: [logEmbed] }).catch(() => {});
              return;
            }
            prob.logMessageId = null;
            saveActiveProblemsToDisk();
          }
          if (existingMsg && !isRecentLogMessage(existingMsg)) {
            prob.logMessageId = null;
            saveActiveProblemsToDisk();
          }
        }
        if (lastClient?.user?.id) {
          const existingMsg = await findExistingLogMessage(logsChannel, prob, lastClient.user.id);
          if (existingMsg) {
            const canEdit = await isMessageInLastTwoBotEmbeds(logsChannel, existingMsg.id, lastClient?.user?.id);
            if (canEdit) {
              prob.logMessageId = existingMsg.id;
              saveActiveProblemsToDisk();
              await existingMsg.edit({ embeds: [logEmbed] }).catch(() => {});
              return;
            }
          }
        }
        // Otherwise send a new embed message and store its ID
        let sentMsg = await logsChannel.send({ embeds: [logEmbed] }).catch(() => null);
        if (!sentMsg && lastClient?.user?.id) {
          const fallbackMsg = await findExistingLogMessage(logsChannel, prob, lastClient.user.id);
          if (fallbackMsg) {
            const canEdit = await isMessageInLastTwoBotEmbeds(logsChannel, fallbackMsg.id, lastClient?.user?.id);
            if (canEdit) {
              prob.logMessageId = fallbackMsg.id;
              saveActiveProblemsToDisk();
              await fallbackMsg.edit({ embeds: [logEmbed] }).catch(() => {});
              return;
            }
          }
          sentMsg = await logsChannel.send({ embeds: [logEmbed] }).catch(() => null);
        }
        if (sentMsg) {
          prob.logMessageId = sentMsg.id;
          saveActiveProblemsToDisk();
          // After sending the embed, if there is a separator image and it has not been sent yet
          // for this problem, send it as a separate message.  Use a flag on the problem to avoid
          // duplicates across multiple updates.
          if (files && files.length > 0 && !prob.separatorSent) {
            try {
              await logsChannel.send({ files });
              prob.separatorSent = true;
              saveActiveProblemsToDisk();
            } catch (_) {}
          }
        }
      } catch (err) {
        console.error('Failed to update problem log:', err);
      }
    }

    /**
     * Remove administrator roles from a member in the context of a voice violation.
     * When a member re-enters a voice channel after being denied, this helper
     * checks for roles granting the Administrator permission and removes them.
     * Any removed roles are recorded in prob.removedAdminRoles so they can be
     * restored when the problem is closed.  No mute role is applied and no
     * timeout is scheduled here.
     * @param {GuildMember} member - The guild member to process.
     * @param {Object} prob - The active problem object to track removed roles.
     */
    async function removeAdminRolesForVoice(member, prob) {
      try {
        // Skip if member no longer has Administrator permission
        if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return;
        }
        // Determine which roles grant Administrator
        const rolesToRemove = [];
        for (const role of member.roles.cache.values()) {
          if (role.permissions.has(PermissionsBitField.Flags.Administrator)) {
            rolesToRemove.push(role.id);
          }
        }
        if (rolesToRemove.length === 0) return;
        // Ensure storage for removed roles
        if (!prob.removedAdminRoles) prob.removedAdminRoles = {};
        if (!prob.removedAdminRoles[member.id]) {
          prob.removedAdminRoles[member.id] = [];
        }
        // Filter out roles already removed
        const newRoles = rolesToRemove.filter(
          (roleId) => !prob.removedAdminRoles[member.id].includes(roleId)
        );
        if (newRoles.length === 0) return;
        // Record and remove the roles
        prob.removedAdminRoles[member.id].push(...newRoles);
        try {
          await member.roles.remove(newRoles);
        } catch (err) {
          console.error('Failed to remove admin roles for voice violation:', err);
        }
        // Persist activeProblems to disk after modifying roles
        saveActiveProblemsToDisk();
      } catch (err) {
        console.error('Error in removeAdminRolesForVoice:', err);
      }
    }
// Build an array of attachment objects for the separator line based on the current configuration.
// If the separator is enabled, this returns an array containing a single AttachmentBuilder
// using a custom image URL (if provided) or the default separator asset.  Otherwise,
// it returns an empty array.
function getSeparatorAttachments() {
  try {
    const cfg = loadProblemConfig();
    // If the separator feature is disabled, return an empty array
    if (!cfg.separatorEnabled) return [];
    // When a custom separator image is provided, determine whether it is a remote URL
    // or a local file path.  If remote (starts with http or https), return a plain
    // object instructing Discord to fetch and display the image.  Otherwise, if it
    // points to a local file on disk, attach the file directly.  If the file no
    // longer exists, fall back to the default separator.
    if (cfg.separatorImage) {
      const isRemote = /^https?:\/\//i.test(cfg.separatorImage);
      const ext = path.extname(cfg.separatorImage).toLowerCase() || '.png';
      const fileName = 'separator' + ext;
      if (isRemote) {
        return [{ attachment: cfg.separatorImage, name: fileName }];
      }
      // If it's a local file path, verify it exists.  If it does, attach it
      try {
        if (fs.existsSync(cfg.separatorImage)) {
          return [{ attachment: cfg.separatorImage, name: path.basename(cfg.separatorImage) }];
        }
      } catch (_) {
        // fall through to default
      }
    }
    // For the default separator asset, construct a plain file object pointing to
    // the local file.  Omitting contentType allows Discord to infer the type and
    // display it inline rather than as a generic file icon.
    const sepPath = path.join(__dirname, '..', 'assets', 'separator.png');
    // If the default separator file exists, attach it. Otherwise fall back to a remote image
    if (fs.existsSync(sepPath)) {
      return [{ attachment: sepPath, name: 'separator.png' }];
    }
    // Fallback remote separator image used in other modules as the default line
    const defaultUrl = 'https://cdn.discordapp.com/attachments/1446184605056106690/1447086623954173972/colors-5.png';
    return [{ attachment: defaultUrl, name: 'separator.png' }];
  } catch (_) {
    // On any error, return an empty array so that no separator is attached
    return [];
  }
}

async function sendSeparatorTest(message) {
  const files = getSeparatorAttachments();
  const description = files.length > 0
    ? '**تم تجهيز الخط الفاصل الحالي. إذا ظهر كصورة فالإعداد صحيح.**'
    : '**الخط الفاصل غير مُفعّل حاليًا. فعّله أولًا من إعدادات البروبلم.**';
  const embed = buildProblemEmbed('Problem Separator Test', description, LOG_THUMBNAIL_URL);
  return message.channel.send({ embeds: [embed], files });
}

// End a problem manually.  This function is invoked via the `problem end`
// subcommand.  It parses two user identifiers from args, finds the
// corresponding problem, restores roles and mutes, sends notifications
// and logs, and removes the problem from the activeProblems map.
async function executeEnd(message, args, context) {
  const { client } = context;
  if (client) lastClient = client;
  const adminRoles = loadAdminRoles();
  const owners = context.BOT_OWNERS || [];
  // Only moderators can end problems
  if (!userIsModerator(message.member, adminRoles, owners)) {
    return message.reply('❌ **ليس لديك صلاحية استخدام هذا الأمر.**');
  }
  if (args.length < 2) {
    return message.reply('❌ **الاستخدام:** problem end <@الطرف الأول> <@الطرف الثاني>');
  }
  // Extract user IDs from mentions or raw IDs
  const id1 = args[0].replace(/[^\d]/g, '');
  const id2 = args[1].replace(/[^\d]/g, '');
  if (!id1 || !id2) {
    return message.reply('❌ **الرجاء تحديد الطرفين بشكل صحيح.**');
  }
  const guildKey = getProblemKey(id1, id2, message.guild.id);
  const legacyKey = getProblemKey(id1, id2);
  const key = activeProblems.has(guildKey) ? guildKey : legacyKey;
  const prob = activeProblems.get(key);
  if (!prob || (prob.guildId && prob.guildId !== message.guild.id)) {
    return message.reply('⚠️ **لا توجد مشكلة نشطة بين الطرفين المحددين.**');
  }
  // Close the problem
  await closeProblem(key, message.guild, context);
  return message.reply('✅ **تم إنهاء المشكلة بنجاح.**');
}

// Internal helper to close and clean up a problem.  Restores any roles
// removed due to Administrator permission, removes mute roles if still
// present, clears channel locks for involved users, sends DM notifications
// that the problem is resolved, and removes the entry from activeProblems.
async function closeProblem(key, guild, context) {
  const prob = activeProblems.get(key);
  if (!prob) return;
  const { firstId, secondId, removedAdminRoles } = prob;
  // Determine who is ending the problem.  When invoked via the `end` command,
  // the caller's ID can be passed in context.endedBy.  Otherwise default to
  // the original moderator who created the problem (prob.moderatorId).
  const endedById = (context && context.endedBy) ? context.endedBy : prob.moderatorId;
  const config = loadProblemConfig();
  // Restore removed admin roles for both parties
  for (const userId of [firstId, secondId]) {
    const rolesRemoved = removedAdminRoles && removedAdminRoles[userId];
    if (rolesRemoved && rolesRemoved.length > 0) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) {
        for (const roleId of rolesRemoved) {
          if (!member.roles.cache.has(roleId)) {
            try {
              await member.roles.add(roleId);
            } catch (err) {
              console.error('Failed to restore admin role on close:', err);
            }
          }
        }
      }
    }
    // Remove mute role if still present
    if (config.muteRoleId) {
      const member2 = await guild.members.fetch(userId).catch(() => null);
      if (member2 && member2.roles.cache.has(config.muteRoleId)) {
        try {
          await member2.roles.remove(config.muteRoleId);
        } catch (err) {
          console.error('Failed to remove mute role on close:', err);
        }
        // Restore any roles that were removed due to SendMessages permission
        const sendRolesRemoved = prob.removedSendRoles && prob.removedSendRoles[userId];
        if (sendRolesRemoved && sendRolesRemoved.length > 0) {
          const memberSend = await guild.members.fetch(userId).catch(() => null);
          if (memberSend) {
            for (const roleId of sendRolesRemoved) {
              if (!memberSend.roles.cache.has(roleId)) {
                try {
                  await memberSend.roles.add(roleId);
                } catch (err) {
                  console.error('Failed to restore send-message role on close:', err);
                }
              }
            }
          }
          delete prob.removedSendRoles[userId];
        }
        // Remove any user-specific overrides that denied SendMessages on channels
        const sendOverrides = prob.removedSendOverrides && prob.removedSendOverrides[userId];
        if (sendOverrides && sendOverrides.length > 0) {
          for (const chanId of sendOverrides) {
            const channel = guild.channels.cache.get(chanId);
            if (channel) {
              try {
                await channel.permissionOverwrites.delete(userId);
              } catch (err) {
                console.error('Failed to remove send-message override on close:', err);
              }
            }
          }
          delete prob.removedSendOverrides[userId];
        }
      }
    }
    // Clear channel locks for this user
    for (const lockKey of Array.from(channelLocks.keys())) {
      if (lockKey.endsWith(':' + userId)) {
        const lock = channelLocks.get(lockKey);
        const [channelId, uid] = lockKey.split(':');
        if (uid === userId) {
          const channel = guild.channels.cache.get(channelId);
          if (channel) {
            try {
              await channel.permissionOverwrites.delete(userId);
            } catch (_) {}
          }
          channelLocks.delete(lockKey);
        }
      }
    }
  }
  // Send DM notifications to both parties that the problem is resolved.  We include
  // the other party and the moderator responsible for ending the problem.  The
  // message format explicitly states that the problem between the two members
  // has ended and identifies the moderator who ended it.
  const { firstId: fId, secondId: sId, reason } = prob;
  const client = context.client;
  try {
    const u1 = await client.users.fetch(fId);
    const description = [
      '**تم إنهاء المشكلة**',
      `**البروبلم بينك انت والطرف الآخر: <@${sId}> انتهت عن طريق المسؤول: <@${endedById}>**`
    ].join('\n');
    await u1.send({
      embeds: [buildProblemEmbed('Problem Resolved', description, u1.displayAvatarURL({ dynamic: true }))]
    });
  } catch (_) {}
  try {
    const u2 = await client.users.fetch(sId);
    const description = [
      '**تم إنهاء المشكلة**',
      `**البروبلم بينك انت والطرف الآخر: <@${fId}> انتهت عن طريق المسؤول: <@${endedById}>**`
    ].join('\n');
    await u2.send({
      embeds: [buildProblemEmbed('Problem Resolved', description, u2.displayAvatarURL({ dynamic: true }))]
    });
  } catch (_) {}
  // Log closure in logs channel.  Identify the moderator who ended the problem and
  // include the previous reason if available.
  if (config.logsChannelId) {
    const logsChannel = await getLogsChannel(guild, config.logsChannelId);
    if (logsChannel) {
      const endedByUser = await client.users.fetch(endedById).catch(() => null);
      const logEmbed = colorManager.createEmbed()
        .setTitle('تم إنهاء مشكلة')
        .setDescription(
          `<@${endedById}> أنهى المشكلة بين <@${fId}> و <@${sId}>` +
            (reason ? `\nالسبب السابق: ${reason}` : '')
        )
        .setTimestamp();
      const endedByAvatar = endedByUser?.displayAvatarURL?.({ dynamic: true });
      if (endedByAvatar) {
        logEmbed.setThumbnail(endedByAvatar);
      }
      // Attach separator line if enabled
      const files = getSeparatorAttachments();
      // Send the main closure embed first without the separator image
      logsChannel.send({ content: '@here', embeds: [logEmbed] }).catch(() => {});
      // Then, if a separator image exists, send it separately so it appears below
      if (files && files.length > 0) {
        logsChannel.send({ files }).catch(() => {});
      }
    }
  }
  // Remove from activeProblems
       activeProblems.delete(key);
       // Persist updated active problems to disk after deleting a case
       saveActiveProblemsToDisk();
  // Persist updated active problems to disk
  saveActiveProblemsToDisk();
  // Clear mute removal warning flags for the involved users to allow future notifications
      muteRemovalWarned.delete(fId);
      muteRemovalWarned.delete(sId);
      // Clear role re-addition warning flags so that future unauthorised role additions are logged again
      roleReaddWarned.delete(fId);
      roleReaddWarned.delete(sId);
}

function buildProblemSetupControls(adminProblemEnabled = true) {
  const controlsRow1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('problem_setup_set_channel')
      .setLabel('تعيين روم السجلات')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('problem_setup_set_role')
      .setLabel('تعيين رول الميوت')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('problem_setup_set_time')
      .setLabel('تعيين مدة الميوت')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('problem_setup_set_responsible_roles')
      .setLabel('تعيين الرولات المسؤولة')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('problem_setup_set_separator')
      .setLabel('تعيين/تعطيل خط الفاصل')
      .setStyle(ButtonStyle.Secondary)
  );

  const controlsRow2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('problem_setup_toggle_admin')
      .setLabel('زر الإدارة (فتح البروبلم)')
      .setStyle(adminProblemEnabled === false ? ButtonStyle.Danger : ButtonStyle.Success)
  );

  return [controlsRow1, controlsRow2];
}

// The problem setup command.  This command now provides an interactive
// configuration embed with buttons to set the logs channel, mute role,
// and mute duration.  When invoked, it displays the current settings
// and allows the moderator to update each via a button which collects
// user input.  All responses are handled privately and the embed is
// updated in place.  The session expires after a short time.
async function executeSetup(message, args, context) {
  const { client } = context;
  if (client) lastClient = client;
  const adminRoles = loadAdminRoles();
  const owners = context.BOT_OWNERS || [];
  const member = message.member;
  // Check permissions: only moderators (owners or admin roles) can run setup
  if (!userIsModerator(member, adminRoles, owners)) {
    return message.reply('❌ **ليس لديك صلاحية استخدام هذا الأمر.**');
  }
  // Load current configuration
  const currentConfig = loadProblemConfig();
  // Prepare fields for current settings
  const logsChannelDisplay = currentConfig.logsChannelId
    ? `<#${currentConfig.logsChannelId}>`
    : 'غير محدد';
  const muteRoleDisplay = currentConfig.muteRoleId
    ? `<@&${currentConfig.muteRoleId}>`
    : 'غير محدد';
  const muteDurationMinutes = Math.round((currentConfig.muteDuration || (10 * 60 * 1000)) / 60000);
  const muteDurationDisplay = `${muteDurationMinutes} دقيقة`;
  const responsibleRolesDisplay = (currentConfig.responsibleRoleIds && currentConfig.responsibleRoleIds.length > 0)
    ? currentConfig.responsibleRoleIds.map((id) => `<@&${id}>`).join(' ، ')
    : 'غير محدد';
  const separatorDisplay = currentConfig.separatorEnabled
    ? (currentConfig.separatorImage ? 'مُفعّل (صورة مخصصة)' : 'مُفعّل')
    : 'غير مُفعل';
  const adminProblemDisplay = currentConfig.adminProblemEnabled === false ? 'مقفّل (مالك السيرفر + الرولات المسؤولة + أونرز البوت)' : 'مُفعّل (نفس المنطق الحالي)';
  // Create embed showing current settings
  const embed = colorManager.createEmbed()
    .setTitle('Problem settings')
    .setDescription('يمكنك تحديث الإعدادات عبر الأزرار أدناه.\nيتم تحديث الإيمبد تلقائيًا بعد أي تغيير.')
    .addFields(
      { name: 'روم السجلات الحالية', value: logsChannelDisplay, inline: true },
      { name: 'رول الميوت الحالي', value: muteRoleDisplay, inline: true },
      { name: 'مدة الميوت الحالية', value: muteDurationDisplay, inline: true },
      { name: 'الرولات المسؤولة الحالية', value: responsibleRolesDisplay, inline: false },
      { name: 'استخدام الخط الفاصل', value: separatorDisplay, inline: false },
      { name: 'وضع الإدارة لفتح البروبلم', value: adminProblemDisplay, inline: false }
    )
    .setTimestamp();
  const setupControls = buildProblemSetupControls(currentConfig.adminProblemEnabled);
  // Send embed and buttons
  const sent = await message.channel.send({ embeds: [embed], components: setupControls });
  // Session store for setup flows (per user)
  const sessionStore = getSessionStore(client);
  sessionStore.set(message.author.id, {
    messageId: sent.id,
    channelId: sent.channel.id,
    config: currentConfig,
    expiresAt: Date.now() + 10 * 60 * 1000 // expire after 10 minutes
  });
  // Register router for problem setup interactions if not already registered
  if (!client._problemSetupRouterRegistered) {
    const ownersList = context.BOT_OWNERS || [];
    interactionRouter.register('problem_setup_', async (interaction, context = {}) => {
      const resolvedClient = context.client || (context.ws ? context : client);
      return handleSetupInteraction(interaction, { client: resolvedClient, BOT_OWNERS: context.BOT_OWNERS || ownersList });
    });
    client._problemSetupRouterRegistered = true;
  }
  // Inform user interactively
  return message.reply({ content: '✅ **تم فتح إعدادات نظام البروبلم.**\nاضغط على الأزرار لتحديث الإعدادات.', allowedMentions: { repliedUser: false } });
}

// Handle setup button interactions.  This function prompts the user
// for input and updates the configuration accordingly.  All replies
// are hidden (ephemeral) and the embed is updated upon success.  It
// ensures the session is valid and belongs to the user initiating the
// setup.
async function handleSetupInteraction(interaction, context) {
  const { client, BOT_OWNERS } = context;
  const id = interaction.customId;
  // Only handle custom IDs for problem_setup_ buttons
  if (!id || !id.startsWith('problem_setup_')) return;
  // Retrieve session
  const sessionStore = getSessionStore(client);
  const session = sessionStore.get(interaction.user.id);
  if (!session) {
    // Session expired or not found
    return interaction.reply({ content: '❌ **لا يوجد إعداد نشط لهذا المستخدم أو انتهت مدة الجلسة.**', ephemeral: true });
  }
  // Verify interaction is for the same message (skip for modal submissions)
  if (!interaction.isModalSubmit() && interaction.message.id !== session.messageId) {
    return interaction.reply({ content: '❌ **هذا التفاعل لا ينتمي لجلسة الإعداد الخاصة بك.**', ephemeral: true });
  }
  if (interaction.isModalSubmit() && id === 'problem_setup_separator_modal') {
    const input = interaction.fields.getTextInputValue('separator_url').trim();
    const lowerInput = input.toLowerCase();
    const cfg = loadProblemConfig();
    if (lowerInput === 'off') {
      cfg.separatorEnabled = false;
      cfg.separatorImage = null;
      saveProblemConfig(cfg);
      await interaction.reply({ content: '✅ **تم تعطيل الخط الفاصل.**', ephemeral: true });
      await refreshEmbed();
      return;
    }
    if (/^https?:\/\//i.test(input)) {
      try {
        const filePath = await downloadSeparatorImage(input);
        cfg.separatorEnabled = true;
        cfg.separatorImage = filePath;
        saveProblemConfig(cfg);
        await interaction.reply({ content: '✅ **تم تعيين الخط الفاصل بنجاح.**', ephemeral: true });
        await refreshEmbed();
      } catch (err) {
        console.error('Error downloading separator image:', err);
        await interaction.reply({ content: '❌ **فشل تعيين الخط الفاصل. يُسمح فقط بروابط HTTPS من Discord CDN (مثل cdn.discordapp.com) ويجب أن تكون صورة صالحة.**', ephemeral: true });
      }
      return;
    }
    await interaction.reply({ content: '❌ **يرجى إدخال رابط صورة صحيح أو كتابة "off".**', ephemeral: true });
    return;
  }
  if (id === 'problem_setup_set_separator') {
    if (session.openingSetupSeparatorModal) {
      return;
    }
    session.openingSetupSeparatorModal = true;
    try {
      const modal = new ModalBuilder()
        .setCustomId('problem_setup_separator_modal')
        .setTitle('تعيين الخط الفاصل');
      const urlInput = new TextInputBuilder()
        .setCustomId('separator_url')
        .setLabel('رابط صورة الخط الفاصل أو off للتعطيل')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('https://example.com/line.png أو off');
      modal.addComponents(new ActionRowBuilder().addComponents(urlInput));
      if (!interaction.replied && !interaction.deferred) {
        await interaction.showModal(modal);
      }
      return;
    } finally {
      session.openingSetupSeparatorModal = false;
    }
  }
  // Defer update to show loading state
  if (!interaction.replied && !interaction.deferred) {
    await interaction.deferUpdate().catch(() => {});
  }
  const guild = interaction.guild;
  // Helper to refresh the embed message after updating config
  async function refreshEmbed() {
    const cfg = loadProblemConfig();
    const logsDisplay = cfg.logsChannelId ? `<#${cfg.logsChannelId}>` : 'غير محدد';
    const roleDisplay = cfg.muteRoleId ? `<@&${cfg.muteRoleId}>` : 'غير محدد';
    const durMinutes = Math.round((cfg.muteDuration || (10 * 60 * 1000)) / 60000);
    const durDisplay = `${durMinutes} دقيقة`;
    const responsibleDisplay = (cfg.responsibleRoleIds && cfg.responsibleRoleIds.length > 0)
      ? cfg.responsibleRoleIds.map((id) => `<@&${id}>`).join(' ، ')
      : 'غير محدد';
    const separatorDisplay = cfg.separatorEnabled
      ? (cfg.separatorImage ? 'مُفعّل (صورة مخصصة)' : 'مُفعّل')
      : 'غير مُفعل';
    const adminProblemDisplay = cfg.adminProblemEnabled === false ? 'مقفّل (مالك السيرفر + الرولات المسؤولة + أونرز البوت)' : 'مُفعّل (نفس المنطق الحالي)';
    const newEmbed = colorManager.createEmbed()
      .setTitle('Problem settings')
      .setDescription('يمكنك تحديث الإعدادات عبر الأزرار أدناه.\nيتم تحديث الإيمبد تلقائيًا بعد أي تغيير.')
      .addFields(
        { name: 'روم السجلات الحالية', value: logsDisplay, inline: true },
        { name: 'رول الميوت الحالي', value: roleDisplay, inline: true },
        { name: 'مدة الميوت الحالية', value: durDisplay, inline: true },
        { name: 'الرولات المسؤولة الحالية', value: responsibleDisplay, inline: false },
        { name: 'استخدام الخط الفاصل', value: separatorDisplay, inline: false },
        { name: 'وضع الإدارة لفتح البروبلم', value: adminProblemDisplay, inline: false }
      )
      .setTimestamp();
    const msg = await interaction.channel.messages.fetch(session.messageId).catch(() => null);
    if (msg) {
      const setupControls = buildProblemSetupControls(cfg.adminProblemEnabled);
      await msg.edit({ embeds: [newEmbed], components: setupControls }).catch(() => {});
    }
  }
  // Determine which setting to update based on button clicked
  if (id === 'problem_setup_toggle_admin') {
    const cfg = loadProblemConfig();
    cfg.adminProblemEnabled = cfg.adminProblemEnabled === false ? true : false;
    saveProblemConfig(cfg);
    const stateText = cfg.adminProblemEnabled === false
      ? '❌ **تم قفل فتح البروبلم للإدارة. الآن المسموح: مالك السيرفر + الرولات المسؤولة + أونرز البوت.**'
      : '✅ **تم تفعيل فتح البروبلم للإدارة (نفس المنطق الحالي).**';
    await interaction.followUp({ content: stateText, ephemeral: true });
    await refreshEmbed();
    return;
  }
  if (id === 'problem_setup_set_channel') {
    // Prompt for channel
    await interaction.followUp({ content: '🔧 **يرجى منشن قناة السجلات أو كتابة الـ ID الخاص بها.**', ephemeral: true });
    // Collect next message from the user
    const filter = (m) => m.author.id === interaction.user.id;
    const collector = interaction.channel.createMessageCollector({ filter, max: 1, time: 60 * 1000 });
    collector.on('collect', async (m) => {
      // Extract channel ID
      const chId = m.content.replace(/[^\d]/g, '');
      const channel = guild.channels.cache.get(chId);
      if (!channel) {
        await interaction.followUp({ content: '❌ **لم يتم العثور على قناة بهذه البيانات.**', ephemeral: true });
      } else {
        // Save config
        const cfg = loadProblemConfig();
        cfg.logsChannelId = chId;
        saveProblemConfig(cfg);
        await interaction.followUp({ content: `✅ **تم تحديث قناة السجلات إلى <#${chId}>.**`, ephemeral: true });
        await refreshEmbed();
      }
      // Delete user message
      try { await m.delete(); } catch (_) {}
    });
    collector.on('end', (collected) => {
      if (collected.size === 0) {
        interaction.followUp({ content: '⚠️ **انتهى الوقت ولم يتم استلام أي قيمة.**', ephemeral: true }).catch(() => {});
      }
    });
  } else if (id === 'problem_setup_set_role') {
    // Prompt for role
    await interaction.followUp({ content: '🔧 **يرجى منشن رول الميوت أو كتابة الـ ID الخاص به.**', ephemeral: true });
    const filter = (m) => m.author.id === interaction.user.id;
    const collector = interaction.channel.createMessageCollector({ filter, max: 1, time: 60 * 1000 });
    collector.on('collect', async (m) => {
      const roleId = m.content.replace(/[^\d]/g, '');
      const role = guild.roles.cache.get(roleId);
      if (!role) {
        await interaction.followUp({ content: '❌ **لم يتم العثور على رول بهذه البيانات.**', ephemeral: true });
      } else {
        const cfg = loadProblemConfig();
        cfg.muteRoleId = roleId;
        saveProblemConfig(cfg);
        await interaction.followUp({ content: `✅ **تم تحديث رول الميوت إلى <@&${roleId}>.**`, ephemeral: true });
        await refreshEmbed();
      }
      try { await m.delete(); } catch (_) {}
    });
    collector.on('end', (collected) => {
      if (collected.size === 0) {
        interaction.followUp({ content: '⚠️ **انتهى الوقت ولم يتم استلام أي قيمة.**', ephemeral: true }).catch(() => {});
      }
    });
  } else if (id === 'problem_setup_set_time') {
    // Prompt for duration
    await interaction.followUp({ content: '🔧 **يرجى إدخال مدة الميوت بالدقائق (رقم صحيح).**', ephemeral: true });
    const filter = (m) => m.author.id === interaction.user.id;
    const collector = interaction.channel.createMessageCollector({ filter, max: 1, time: 60 * 1000 });
    collector.on('collect', async (m) => {
      const value = m.content.trim();
      const minutes = parseInt(value, 10);
      if (isNaN(minutes) || minutes <= 0) {
        await interaction.followUp({ content: '❌ **يجب إدخال رقم صحيح يمثل الدقائق.**', ephemeral: true });
      } else {
        const cfg = loadProblemConfig();
        cfg.muteDuration = minutes * 60 * 1000;
        saveProblemConfig(cfg);
        await interaction.followUp({ content: `✅ **تم تحديث مدة الميوت إلى ${minutes} دقيقة.**`, ephemeral: true });
        await refreshEmbed();
      }
      try { await m.delete(); } catch (_) {}
    });
    collector.on('end', (collected) => {
      if (collected.size === 0) {
        interaction.followUp({ content: '⚠️ **انتهى الوقت ولم يتم استلام أي قيمة.**', ephemeral: true }).catch(() => {});
      }
    });
  } else if (id === 'problem_setup_set_responsible_roles') {
    // Prompt for responsible roles
    await interaction.followUp({ content: '🔧 **يرجى منشن الرولات التي تريد تعيينها كرولات مسؤولة أو كتابة الـ IDs الخاصة بها (يمكن إدخال أكثر من رول).**', ephemeral: true });
    const filter = (m) => m.author.id === interaction.user.id;
    const collector = interaction.channel.createMessageCollector({ filter, max: 1, time: 60 * 1000 });
    collector.on('collect', async (m) => {
      // Extract all role IDs from the message (mentions or plain IDs)
      const ids = m.content.match(/\d{17,19}/g) || [];
      const uniqueIds = Array.from(new Set(ids));
      const validRoleIds = [];
      for (const rid of uniqueIds) {
        const role = guild.roles.cache.get(rid);
        if (role) {
          validRoleIds.push(rid);
        }
      }
      if (validRoleIds.length === 0) {
        await interaction.followUp({ content: '❌ **لم يتم العثور على أية رولات صالحة في الإدخال.**', ephemeral: true });
      } else {
        const cfg = loadProblemConfig();
        cfg.responsibleRoleIds = validRoleIds;
        saveProblemConfig(cfg);
        const mentions = validRoleIds.map((rid) => `<@&${rid}>`).join(' ، ');
        await interaction.followUp({ content: `✅ **تم تحديث الرولات المسؤولة إلى:** ${mentions}`, ephemeral: true });
        await refreshEmbed();
      }
      try {
        await m.delete();
      } catch (_) {}
    });
    collector.on('end', (collected) => {
      if (collected.size === 0) {
        interaction.followUp({ content: '⚠️ **انتهى الوقت ولم يتم استلام أي قيمة.**', ephemeral: true }).catch(() => {});
      }
    });
  }
}

module.exports = {
  name,
  execute,
  executeSetup,
  handleInteraction,
  handleMessage,
  handleVoice,
  handleMemberUpdate
  // Export activeProblems and helper functions so other commands can
  // interact with the problem store.  closeProblem is included to
  // allow other modules to end problems.
  ,activeProblems,
  getProblemKey,
  closeProblem,

  saveActiveProblemsToDisk

};
