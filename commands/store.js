const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  PermissionFlagsBits
} = require('discord.js');
const colorManager = require('../utils/colorManager.js');

const name = 'store';
const aliases = ['ستور'];

const dataPath = path.join(__dirname, '..', 'data', 'storeSettings.json');
const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');

const tempFontUrls = new Map();
const tempReactionSets = new Map();
const tempCleanupChannels = new Map();
const tempReactionRoleSetup = new Map();
const cleanupTimers = new Map();

function ensureDataDir() {
  const dir = path.dirname(dataPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeGuildConfig(cfg = {}) {
  return {
    autoRoleId: cfg.autoRoleId || null,
    fontChannels: cfg.fontChannels || {},
    autoReactions: cfg.autoReactions || {},
    autoCleanup: cfg.autoCleanup || {},
    reactionRole: cfg.reactionRole || null,
    mediaOnlyChannels: Array.isArray(cfg.mediaOnlyChannels) ? cfg.mediaOnlyChannels : []
  };
}

function readStoreData() {
  try {
    if (!fs.existsSync(dataPath)) return {};
    const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    for (const guildId of Object.keys(raw)) raw[guildId] = normalizeGuildConfig(raw[guildId]);
    return raw;
  } catch (error) {
    console.error('خطأ في قراءة storeSettings:', error);
    return {};
  }
}

function saveStoreData(data) {
  try {
    ensureDataDir();
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error('خطأ في حفظ storeSettings:', error);
    return false;
  }
}

function loadAdminRoles() {
  try {
    if (!fs.existsSync(adminRolesPath)) return [];
    const data = JSON.parse(fs.readFileSync(adminRolesPath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function memberIsAdmin(member, botOwners = []) {
  if (!member || !member.guild) return false;
  if (botOwners.includes(member.id) || member.guild.ownerId === member.id) return true;
  if (member.permissions.has('Administrator')) return true;

  const adminRoles = loadAdminRoles();
  return adminRoles.length > 0 && member.roles.cache.some((role) => adminRoles.includes(role.id));
}

function getGuildConfig(guildId) {
  const all = readStoreData();
  if (!all[guildId]) {
    all[guildId] = normalizeGuildConfig({});
    saveStoreData(all);
  }
  return normalizeGuildConfig(all[guildId]);
}

function setGuildConfig(guildId, updater) {
  const all = readStoreData();
  if (!all[guildId]) all[guildId] = normalizeGuildConfig({});
  all[guildId] = normalizeGuildConfig(all[guildId]);
  updater(all[guildId]);
  all[guildId] = normalizeGuildConfig(all[guildId]);
  saveStoreData(all);
}

function shortText(text = '', max = 70) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'بدون نص';
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function formatConfig(config) {
  const fontLines = Object.entries(config.fontChannels || {});
  const reactionLines = Object.entries(config.autoReactions || {});
  const cleanupLines = Object.entries(config.autoCleanup || {});
  const rr = config.reactionRole;

  const cleanupText = cleanupLines.length
    ? cleanupLines.map(([channelId, item], i) => {
      const mode = item?.useEmbed ? 'Embed' : 'Message';
      return `**${i + 1}.** <#${channelId}>\n**كل :** ${item.intervalMinutes} دقيقة\n**الوضع :** ${mode}`;
    }).join('\n\n')
    : '**غير محدد**';

  const rrText = rr
    ? `**الشات :** <#${rr.channelId}>\n**الرسالة :** [${rr.messageId}](https://discord.com/channels/${rr.guildId}/${rr.channelId}/${rr.messageId})\n**الرول :** <@&${rr.roleId}>\n**الإيموجي :** ${rr.emoji}`
    : '**غير محدد**';

  const mediaText = config.mediaOnlyChannels.length
    ? config.mediaOnlyChannels.map((id, i) => `**${i + 1}.** <#${id}>`).join('\n')
    : '**غير محدد**';

  return {
    fontText: fontLines.length
      ? fontLines.map(([channelId, url], i) => `**${i + 1}.** <#${channelId}>\n**الرابط :** ${url}`).join('\n\n')
      : '**غير محدد**',
    reactionText: reactionLines.length
      ? reactionLines.map(([channelId, emojis], i) => `**${i + 1}.** <#${channelId}>\n**الإيموجيات :** ${emojis.join(' ')}`).join('\n\n')
      : '**غير محدد**',
    autoRoleText: config.autoRoleId ? `<@&${config.autoRoleId}>` : '**غير محدد**',
    cleanupText,
    rrText,
    mediaText
  };
}

function buildStoreEmbed(guildId) {
  const config = getGuildConfig(guildId);
  const view = formatConfig(config);

  return colorManager.createEmbed()
    .setTitle('Store Settings')
    .setDescription(
      '**الخط :**\n' +
      `${view.fontText}\n\n` +
      '**الرياكشن التلقائي :**\n' +
      `${view.reactionText}\n\n` +
      '**الرول التلقائي :**\n' +
      `${view.autoRoleText}\n\n` +
      '**المسح التلقائي :**\n' +
      `${view.cleanupText}\n\n` +
      '**Reaction Role :**\n' +
      `${view.rrText}\n\n` +
      '**رومات صور وفيديو :**\n' +
      `${view.mediaText}`
    )
    .setFooter({ text: 'استخدم الأزرار بالأسفل للإضافة أو الإزالة.' });
}

function buildStoreComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('store_font_btn').setLabel('إعداد الخط').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('store_reaction_btn').setLabel('إعداد الرياكشن').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('store_autorole_btn').setLabel('إعداد الرول').setStyle(ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('store_cleanup_btn').setLabel('إعداد المسح التلقائي').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('store_reaction_role_btn').setLabel('إعداد رياكشن رول').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('store_media_only_btn').setLabel('إعداد الرومات').setStyle(ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('store_remove_btn').setLabel('إزالة إعداد').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('store_refresh_btn').setLabel('تحديث').setStyle(ButtonStyle.Secondary)
    )
  ];
}

async function execute(message, args, { BOT_OWNERS = [] }) {
  if (!memberIsAdmin(message.member, BOT_OWNERS)) {
    await message.react('❌');
    return;
  }

  await message.channel.send({
    embeds: [buildStoreEmbed(message.guild.id)],
    components: buildStoreComponents()
  });
}

function parseEmojis(input = '') {
  const customRegex = /<a?:[^:>]{2,32}:(\d{17,20})>/g;
  const custom = input.match(customRegex) || [];
  const removedCustom = input.replace(customRegex, ' ');
  const unicode = removedCustom.split(/\s+/).map((x) => x.trim()).filter(Boolean);
  return [...custom, ...unicode].slice(0, 10);
}

function normalizeReactEmoji(emoji) {
  return String(emoji || '').trim();
}

function parseGuildEmoji(raw = '') {
  const match = raw.trim().match(/^<a?:[^:>]{2,32}:(\d{17,20})>$/);
  if (!match) return null;
  return match[1];
}

function buildMessagePreviewOptions(messages) {
  return messages.map((msg, index) => {
    const attachmentNames = [...msg.attachments.values()]
      .slice(0, 2)
      .map((att, i) => att.contentType?.startsWith('image/') ? `صورة ${i + 1}` : `ملف ${i + 1}`);
    const label = shortText(msg.content || attachmentNames.join(' , ') || 'رسالة بدون نص', 90);
    const description = `المرسل : ${shortText(msg.author?.displayName || msg.author?.username || 'Unknown', 40)} | ID: ${msg.id}`;
    return { label, value: msg.id, description: shortText(description, 95) };
  }).slice(0, 25);
}

function isAllowedMediaMessage(message) {
  if (!message || !message.attachments) return false;
  if (message.attachments.size === 0) return false;
  for (const att of message.attachments.values()) {
    const type = String(att.contentType || '').toLowerCase();
    const name = String(att.name || '').toLowerCase();
    if (
      type.startsWith('image/') ||
      type.startsWith('video/') ||
      name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png') || name.endsWith('.gif') || name.endsWith('.webp') ||
      name.endsWith('.mp4') || name.endsWith('.mp3')
    ) {
      continue;
    }
    return false;
  }
  return true;
}

async function purgeChannel(channel) {
  if (!channel || !channel.isTextBased?.()) return;
  const now = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!batch || batch.size === 0) break;

    const recent = batch.filter((m) => now - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
    const old = batch.filter((m) => now - m.createdTimestamp >= 14 * 24 * 60 * 60 * 1000);

    if (recent.size > 0) await channel.bulkDelete(recent, true).catch(() => {});

    if (old.size > 0) {
      for (const msg of old.values()) {
        await msg.delete().catch(() => {});
      }
    }

    if (batch.size < 100) break;
  }
}

function buildCleanupPayload(guild, cleanupCfg) {
  const text = String(cleanupCfg.messageText || '').trim();
  const imageUrl = String(cleanupCfg.imageUrl || '').trim();
  const useEmbed = Boolean(cleanupCfg.useEmbed);

  if (useEmbed) {
    const embed = colorManager.createEmbed()
      .setAuthor({ name: guild.name, iconURL: guild.iconURL({ dynamic: true }) || undefined })
      .setDescription(text || ' ')
      .setTimestamp();
    if (/^https?:\/\//i.test(imageUrl)) embed.setImage(imageUrl);
    return { embeds: [embed] };
  }

  return {
    content: text || null,
    files: /^https?:\/\//i.test(imageUrl) ? [imageUrl] : []
  };
}

function rescheduleCleanupJobs(client, guildId) {
  const keyPrefix = `${guildId}:`;
  for (const key of cleanupTimers.keys()) {
    if (key.startsWith(keyPrefix)) {
      clearInterval(cleanupTimers.get(key));
      cleanupTimers.delete(key);
    }
  }

  const cfg = getGuildConfig(guildId);
  const jobs = Object.entries(cfg.autoCleanup || {});

  for (const [channelId, cleanupCfg] of jobs) {
    const minutes = Number(cleanupCfg.intervalMinutes || 0);
    if (!Number.isFinite(minutes) || minutes < 1) continue;

    const timer = setInterval(async () => {
      try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;

        const channel = guild.channels.cache.get(channelId);
        if (!channel || channel.type !== ChannelType.GuildText) return;

        const me = guild.members.me;
        if (!me) return;
        const perms = channel.permissionsFor(me);
        if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.ManageMessages) || !perms?.has(PermissionFlagsBits.SendMessages)) {
          return;
        }

        await purgeChannel(channel);
        const payload = buildCleanupPayload(guild, cleanupCfg);
        if ((payload.content && payload.content.length > 0) || (payload.embeds && payload.embeds.length) || (payload.files && payload.files.length)) {
          await channel.send(payload).catch(() => {});
        }
      } catch (error) {
        console.error('store autoCleanup timer error:', error);
      }
    }, minutes * 60 * 1000);

    cleanupTimers.set(`${guildId}:${channelId}`, timer);
  }
}

function registerInteractionHandler(client) {
  if (client.__storeHandlersRegistered) return;
  client.__storeHandlersRegistered = true;

  for (const guildId of Object.keys(readStoreData())) {
    rescheduleCleanupJobs(client, guildId);
  }

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.guild) return;

      const member = interaction.member;
      const isAdmin = memberIsAdmin(member, global.BOT_OWNERS || []);

      const adminOnly = [
        'store_font_btn', 'store_reaction_btn', 'store_autorole_btn', 'store_remove_btn', 'store_refresh_btn',
        'store_cleanup_btn', 'store_reaction_role_btn', 'store_media_only_btn',
        'store_font_channels', 'store_react_channels', 'store_autorole_role', 'store_remove_type',
        'store_remove_font_channels', 'store_remove_react_channels', 'store_cleanup_channels',
        'store_remove_cleanup_channels', 'store_remove_media_channels', 'store_media_channels',
        'store_rr_pick_channel', 'store_rr_pick_message', 'store_rr_pick_role', 'store_remove_reaction_role'
      ];

      if (interaction.isButton() && adminOnly.includes(interaction.customId) && !isAdmin) {
        await interaction.reply({ content: '❌ هذا الإعداد للإدارة فقط.', ephemeral: true });
        return;
      }
      if ((interaction.isChannelSelectMenu() || interaction.isRoleSelectMenu() || interaction.isStringSelectMenu()) && adminOnly.includes(interaction.customId) && !isAdmin) {
        await interaction.reply({ content: '❌ هذا الإعداد للإدارة فقط.', ephemeral: true });
        return;
      }

      if (interaction.isButton() && interaction.customId === 'store_refresh_btn') {
        await interaction.update({ embeds: [buildStoreEmbed(interaction.guild.id)], components: buildStoreComponents() });
        return;
      }

      if (interaction.isButton() && interaction.customId === 'store_font_btn') {
        const modal = new ModalBuilder().setCustomId('store_font_modal').setTitle('إعداد الخط');
        const input = new TextInputBuilder()
          .setCustomId('store_font_url')
          .setLabel('رابط صورة الخط')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('https://example.com/line.png');

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return;
      }

      if (interaction.isButton() && interaction.customId === 'store_reaction_btn') {
        const modal = new ModalBuilder().setCustomId('store_reaction_modal').setTitle('إعداد الرياكشن التلقائي');
        const input = new TextInputBuilder()
          .setCustomId('store_reaction_values')
          .setLabel('الإيموجيات (مسافة بين كل إيموجي)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('😀 🔥 <:name:123456789012345678>');

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return;
      }

      if (interaction.isButton() && interaction.customId === 'store_cleanup_btn') {
        const row = new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId('store_cleanup_channels')
            .setPlaceholder('اختر الرومات للمسح التلقائي')
            .setMinValues(1)
            .setMaxValues(10)
            .addChannelTypes(ChannelType.GuildText)
        );
        await interaction.reply({ content: '**اختر الرومات ثم سيتم فتح مودال إعداد المسح.**', components: [row], ephemeral: true });
        return;
      }

      if (interaction.isButton() && interaction.customId === 'store_reaction_role_btn') {
        const row = new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId('store_rr_pick_channel')
            .setPlaceholder('اختر روم الرسالة')
            .setMinValues(1)
            .setMaxValues(1)
            .addChannelTypes(ChannelType.GuildText)
        );
        await interaction.reply({ content: '**اختر الروم الذي يحتوي رسالة الرياكشن رول.**', components: [row], ephemeral: true });
        return;
      }

      if (interaction.isButton() && interaction.customId === 'store_media_only_btn') {
        const row = new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId('store_media_channels')
            .setPlaceholder('اختر رومات الصور والفيديو')
            .setMinValues(1)
            .setMaxValues(10)
            .addChannelTypes(ChannelType.GuildText)
        );
        await interaction.reply({ content: '**اختر الرومات التي تسمح فقط بالصور والفيديو و mp3/mp4.**', components: [row], ephemeral: true });
        return;
      }

      if (interaction.isButton() && interaction.customId === 'store_autorole_btn') {
        const row = new ActionRowBuilder().addComponents(
          new RoleSelectMenuBuilder()
            .setCustomId('store_autorole_role')
            .setPlaceholder('اختر الرول التلقائي')
            .setMinValues(1)
            .setMaxValues(1)
        );
        await interaction.reply({ content: '**اختر الرول الذي ينضاف تلقائياً عند دخول عضو جديد :**', components: [row], ephemeral: true });
        return;
      }

      if (interaction.isButton() && interaction.customId === 'store_remove_btn') {
        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('store_remove_type')
            .setPlaceholder('اختر نوع الإزالة')
            .addOptions([
              { label: 'إزالة خط', value: 'font', description: 'إزالة إعداد الخط من شاتات محددة' },
              { label: 'إزالة رياكشن تلقائي', value: 'reaction', description: 'إزالة الرياكشن التلقائي من شاتات محددة' },
              { label: 'إزالة الرول التلقائي', value: 'autorole', description: 'إلغاء إعطاء الرول عند الدخول' },
              { label: 'إزالة المسح التلقائي', value: 'cleanup', description: 'إلغاء المسح التلقائي من رومات' },
              { label: 'إزالة Reaction Role', value: 'reactionrole', description: 'حذف ربط الإيموجي والرول' },
              { label: 'إزالة رومات الصور والفيديو', value: 'mediaonly', description: 'إزالة منع المحتوى غير المسموح' }
            ])
        );
        await interaction.reply({ content: '**حدد الإعداد الذي تريد حذفه :**', components: [row], ephemeral: true });
        return;
      }

      if (interaction.isStringSelectMenu() && interaction.customId === 'store_remove_type') {
        const selected = interaction.values[0];
        if (selected === 'autorole') {
          setGuildConfig(interaction.guild.id, (cfg) => { cfg.autoRoleId = null; });
          await interaction.update({ content: '✅ تم حذف الرول التلقائي.', components: [] });
          return;
        }
        if (selected === 'reactionrole') {
          setGuildConfig(interaction.guild.id, (cfg) => { cfg.reactionRole = null; });
          await interaction.update({ content: '✅ تم حذف إعداد Reaction Role.', components: [] });
          return;
        }

        if (selected === 'mediaonly') {
          const row = new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId('store_remove_media_channels')
              .setPlaceholder('اختر الرومات')
              .setMinValues(1)
              .setMaxValues(10)
              .addChannelTypes(ChannelType.GuildText)
          );
          await interaction.update({ content: '**اختر الرومات التي تريد إزالة إعداد الوسائط منها.**', components: [row] });
          return;
        }

        if (selected === 'cleanup') {
          const row = new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId('store_remove_cleanup_channels')
              .setPlaceholder('اختر الرومات')
              .setMinValues(1)
              .setMaxValues(10)
              .addChannelTypes(ChannelType.GuildText)
          );
          await interaction.update({ content: '**اختر الرومات التي تريد إزالة المسح التلقائي منها.**', components: [row] });
          return;
        }

        const targetId = selected === 'font' ? 'store_remove_font_channels' : 'store_remove_react_channels';
        const row = new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId(targetId)
            .setPlaceholder('اختر الشاتات')
            .setMinValues(1)
            .setMaxValues(10)
            .addChannelTypes(ChannelType.GuildText)
        );
        await interaction.update({ content: '**اختر الشاتات التي تريد إزالة الإعداد منها :**', components: [row] });
        return;
      }

      if (interaction.isChannelSelectMenu() && interaction.customId === 'store_remove_font_channels') {
        setGuildConfig(interaction.guild.id, (cfg) => {
          for (const channelId of interaction.values) delete cfg.fontChannels[channelId];
        });
        await interaction.update({ content: '✅ تم حذف إعداد الخط من الشاتات المحددة.', components: [] });
        return;
      }

      if (interaction.isChannelSelectMenu() && interaction.customId === 'store_remove_react_channels') {
        setGuildConfig(interaction.guild.id, (cfg) => {
          for (const channelId of interaction.values) delete cfg.autoReactions[channelId];
        });
        await interaction.update({ content: '✅ تم حذف إعداد الرياكشن من الشاتات المحددة.', components: [] });
        return;
      }

      if (interaction.isChannelSelectMenu() && interaction.customId === 'store_remove_cleanup_channels') {
        setGuildConfig(interaction.guild.id, (cfg) => {
          for (const channelId of interaction.values) delete cfg.autoCleanup[channelId];
        });
        rescheduleCleanupJobs(client, interaction.guild.id);
        await interaction.update({ content: '✅ تم حذف إعداد المسح التلقائي من الرومات المحددة.', components: [] });
        return;
      }

      if (interaction.isChannelSelectMenu() && interaction.customId === 'store_remove_media_channels') {
        setGuildConfig(interaction.guild.id, (cfg) => {
          cfg.mediaOnlyChannels = cfg.mediaOnlyChannels.filter((id) => !interaction.values.includes(id));
        });
        await interaction.update({ content: '✅ تم حذف إعداد رومات الصور والفيديو.', components: [] });
        return;
      }

      if (interaction.isRoleSelectMenu() && interaction.customId === 'store_autorole_role') {
        const roleId = interaction.values[0];
        setGuildConfig(interaction.guild.id, (cfg) => { cfg.autoRoleId = roleId; });
        await interaction.update({ content: `✅ تم ضبط الرول التلقائي : <@&${roleId}>`, components: [] });
        return;
      }

      if (interaction.isChannelSelectMenu() && interaction.customId === 'store_font_channels') {
        const key = `${interaction.guild.id}:${interaction.user.id}`;
        const imageUrl = tempFontUrls.get(key);
        if (!imageUrl) {
          await interaction.update({ content: '❌ انتهت الجلسة، أعد المحاولة.', components: [] });
          return;
        }

        setGuildConfig(interaction.guild.id, (cfg) => {
          for (const channelId of interaction.values) cfg.fontChannels[channelId] = imageUrl;
        });
        tempFontUrls.delete(key);
        await interaction.update({ content: '✅ تم حفظ الخط للشاتات المحددة.', components: [] });
        return;
      }

      if (interaction.isChannelSelectMenu() && interaction.customId === 'store_react_channels') {
        const key = `${interaction.guild.id}:${interaction.user.id}`;
        const emojis = tempReactionSets.get(key);
        if (!emojis || emojis.length === 0) {
          await interaction.update({ content: '❌ انتهت الجلسة، أعد المحاولة.', components: [] });
          return;
        }

        setGuildConfig(interaction.guild.id, (cfg) => {
          for (const channelId of interaction.values) cfg.autoReactions[channelId] = emojis;
        });
        tempReactionSets.delete(key);
        await interaction.update({ content: '✅ تم حفظ الرياكشن التلقائي للشاتات المحددة.', components: [] });
        return;
      }

      if (interaction.isChannelSelectMenu() && interaction.customId === 'store_cleanup_channels') {
        tempCleanupChannels.set(`${interaction.guild.id}:${interaction.user.id}`, interaction.values);

        const modal = new ModalBuilder().setCustomId('store_cleanup_modal').setTitle('إعداد المسح التلقائي');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('store_cleanup_minutes')
              .setLabel('وقت المسح بالدقائق')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setPlaceholder('5')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('store_cleanup_text')
              .setLabel('نص الرسالة بعد الحذف (اختياري)')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
              .setPlaceholder('اكتب النص المطلوب')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('store_cleanup_image')
              .setLabel('رابط صورة مباشر (اختياري)')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setPlaceholder('https://example.com/image.png')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('store_cleanup_embed')
              .setLabel('Embed ? yes / no')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setPlaceholder('yes')
          )
        );

        await interaction.showModal(modal);
        return;
      }

      if (interaction.isChannelSelectMenu() && interaction.customId === 'store_rr_pick_channel') {
        const channelId = interaction.values[0];
        const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (!channel || channel.type !== ChannelType.GuildText) {
          await interaction.update({ content: '❌ الشات غير صالح.', components: [] });
          return;
        }

        const msgs = await channel.messages.fetch({ limit: 25 }).catch(() => null);
        if (!msgs || msgs.size === 0) {
          await interaction.update({ content: '❌ لا توجد رسائل في هذا الشات.', components: [] });
          return;
        }

        const ordered = [...msgs.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
        const options = buildMessagePreviewOptions(ordered);
        tempReactionRoleSetup.set(`${interaction.guild.id}:${interaction.user.id}`, { channelId });

        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('store_rr_pick_message')
            .setPlaceholder('اختر الرسالة')
            .addOptions(options)
        );

        await interaction.update({ content: '**اختر الرسالة من آخر 25 رسالة في الروم.**', components: [row] });
        return;
      }

      if (interaction.isStringSelectMenu() && interaction.customId === 'store_rr_pick_message') {
        const key = `${interaction.guild.id}:${interaction.user.id}`;
        const setup = tempReactionRoleSetup.get(key);
        if (!setup?.channelId) {
          await interaction.update({ content: '❌ انتهت الجلسة، أعد المحاولة.', components: [] });
          return;
        }

        setup.messageId = interaction.values[0];
        tempReactionRoleSetup.set(key, setup);

        const row = new ActionRowBuilder().addComponents(
          new RoleSelectMenuBuilder()
            .setCustomId('store_rr_pick_role')
            .setPlaceholder('اختر الرول المرتبط')
            .setMinValues(1)
            .setMaxValues(1)
        );

        await interaction.update({ content: '**اختر الرول الذي سيتم منحه عند إضافة الرياكشن.**', components: [row] });
        return;
      }

      if (interaction.isRoleSelectMenu() && interaction.customId === 'store_rr_pick_role') {
        const key = `${interaction.guild.id}:${interaction.user.id}`;
        const setup = tempReactionRoleSetup.get(key);
        if (!setup?.channelId || !setup?.messageId) {
          await interaction.update({ content: '❌ انتهت الجلسة، أعد المحاولة.', components: [] });
          return;
        }

        setup.roleId = interaction.values[0];
        tempReactionRoleSetup.set(key, setup);

        const modal = new ModalBuilder().setCustomId('store_rr_emoji_modal').setTitle('إدخال إيموجي السيرفر');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('store_rr_emoji')
              .setLabel('أرسل الإيموجي بين قوسين')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setPlaceholder('<:name:123456789012345678>')
          )
        );

        await interaction.showModal(modal);
        return;
      }

      if (interaction.isChannelSelectMenu() && interaction.customId === 'store_media_channels') {
        setGuildConfig(interaction.guild.id, (cfg) => {
          cfg.mediaOnlyChannels = [...new Set([...(cfg.mediaOnlyChannels || []), ...interaction.values])];
        });
        await interaction.update({ content: '✅ تم حفظ إعداد رومات الصور والفيديو.', components: [] });
        return;
      }

      if (!interaction.isModalSubmit()) return;

      if (interaction.customId === 'store_font_modal') {
        const url = interaction.fields.getTextInputValue('store_font_url').trim();
        if (!/^https?:\/\//i.test(url)) {
          await interaction.reply({ content: '❌ رابط الصورة غير صالح.', ephemeral: true });
          return;
        }

        tempFontUrls.set(`${interaction.guild.id}:${interaction.user.id}`, url);

        const row = new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId('store_font_channels')
            .setPlaceholder('اختر الشاتات للخط')
            .setMinValues(1)
            .setMaxValues(10)
            .addChannelTypes(ChannelType.GuildText)
        );

        await interaction.reply({ content: '**اختر الشاتات التي تريد تطبيق الخط فيها :**', components: [row], ephemeral: true });
        return;
      }

      if (interaction.customId === 'store_reaction_modal') {
        const raw = interaction.fields.getTextInputValue('store_reaction_values');
        const emojis = parseEmojis(raw);

        if (emojis.length === 0) {
          await interaction.reply({ content: '❌ ما تم التعرف على أي إيموجي صالح.', ephemeral: true });
          return;
        }

        tempReactionSets.set(`${interaction.guild.id}:${interaction.user.id}`, emojis);

        const row = new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId('store_react_channels')
            .setPlaceholder('اختر شاتات الرياكشن')
            .setMinValues(1)
            .setMaxValues(10)
            .addChannelTypes(ChannelType.GuildText)
        );

        await interaction.reply({ content: '**اختر الشاتات التي سيتم فيها إضافة الرياكشن تلقائياً :**', components: [row], ephemeral: true });
        return;
      }

      if (interaction.customId === 'store_cleanup_modal') {
        const key = `${interaction.guild.id}:${interaction.user.id}`;
        const channels = tempCleanupChannels.get(key) || [];
        if (!channels.length) {
          await interaction.reply({ content: '❌ انتهت الجلسة، أعد الإعداد من جديد.', ephemeral: true });
          return;
        }

        const minutes = Number(interaction.fields.getTextInputValue('store_cleanup_minutes').trim());
        const text = interaction.fields.getTextInputValue('store_cleanup_text').trim();
        const image = interaction.fields.getTextInputValue('store_cleanup_image').trim();
        const embedValue = interaction.fields.getTextInputValue('store_cleanup_embed').trim().toLowerCase();
        const useEmbed = ['yes', 'y', 'true', '1', 'اي', 'نعم'].includes(embedValue);

        if (!Number.isFinite(minutes) || minutes < 1) {
          await interaction.reply({ content: '❌ وقت المسح غير صالح. الحد الأدنى دقيقة واحدة.', ephemeral: true });
          return;
        }

        if (image && !/^https?:\/\//i.test(image)) {
          await interaction.reply({ content: '❌ رابط الصورة غير صالح.', ephemeral: true });
          return;
        }

        if (!text && !image) {
          await interaction.reply({ content: '❌ يجب كتابة نص أو وضع رابط صورة على الأقل.', ephemeral: true });
          return;
        }

        setGuildConfig(interaction.guild.id, (cfg) => {
          for (const channelId of channels) {
            cfg.autoCleanup[channelId] = {
              intervalMinutes: minutes,
              messageText: text,
              imageUrl: image,
              useEmbed
            };
          }
        });
        tempCleanupChannels.delete(key);
        rescheduleCleanupJobs(client, interaction.guild.id);

        await interaction.reply({
          content: `✅ تم حفظ المسح التلقائي لـ ${channels.length} روم.\n**الوقت :** ${minutes} دقيقة\n**الوضع :** ${useEmbed ? 'Embed' : 'Message'}`,
          ephemeral: true
        });
        return;
      }

      if (interaction.customId === 'store_rr_emoji_modal') {
        const key = `${interaction.guild.id}:${interaction.user.id}`;
        const setup = tempReactionRoleSetup.get(key);
        if (!setup?.channelId || !setup?.messageId || !setup?.roleId) {
          await interaction.reply({ content: '❌ انتهت الجلسة، أعد المحاولة.', ephemeral: true });
          return;
        }

        const rawEmoji = interaction.fields.getTextInputValue('store_rr_emoji').trim();
        const emojiId = parseGuildEmoji(rawEmoji);
        if (!emojiId) {
          await interaction.reply({ content: '❌ يجب إدخال إيموجي سيرفر بصيغة <:name:id>.', ephemeral: true });
          return;
        }

        const guildEmoji = interaction.guild.emojis.cache.get(emojiId);
        if (!guildEmoji) {
          await interaction.reply({ content: '❌ الإيموجي غير موجود في السيرفر.', ephemeral: true });
          return;
        }

        const channel = await interaction.guild.channels.fetch(setup.channelId).catch(() => null);
        if (!channel || !channel.isTextBased?.()) {
          await interaction.reply({ content: '❌ الشات المحدد غير متاح.', ephemeral: true });
          return;
        }

        const targetMessage = await channel.messages.fetch(setup.messageId).catch(() => null);
        if (!targetMessage) {
          await interaction.reply({ content: '❌ الرسالة المحددة غير موجودة.', ephemeral: true });
          return;
        }

        await targetMessage.react(guildEmoji.toString()).catch(() => {});

        setGuildConfig(interaction.guild.id, (cfg) => {
          cfg.reactionRole = {
            guildId: interaction.guild.id,
            channelId: setup.channelId,
            messageId: setup.messageId,
            roleId: setup.roleId,
            emoji: guildEmoji.toString(),
            emojiId: guildEmoji.id
          };
        });
        tempReactionRoleSetup.delete(key);

        await interaction.reply({
          content: `✅ تم حفظ Reaction Role.\n**الشات :** <#${setup.channelId}>\n**الرسالة :** ${setup.messageId}\n**الرول :** <@&${setup.roleId}>\n**الإيموجي :** ${guildEmoji}`,
          ephemeral: true
        });
        return;
      }
    } catch (error) {
      console.error('Store interaction handler error:', error);
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: '❌ حدث خطأ أثناء تنفيذ العملية.', ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ content: '❌ حدث خطأ أثناء تنفيذ العملية.', ephemeral: true }).catch(() => {});
      }
    }
  });

  client.on('messageCreate', async (message) => {
    try {
      if (!message.guild || message.author.bot) return;
      const config = getGuildConfig(message.guild.id);

      const lineImage = config.fontChannels?.[message.channel.id];
      if (lineImage) {
        await message.channel.send({ files: [lineImage] }).catch(() => {});
      }

      const reactions = config.autoReactions?.[message.channel.id] || [];
      if (Array.isArray(reactions) && reactions.length > 0) {
        for (const emoji of reactions.slice(0, 10)) {
          await message.react(normalizeReactEmoji(emoji)).catch(() => {});
        }
      }

      const mediaOnlySet = new Set(config.mediaOnlyChannels || []);
      if (mediaOnlySet.has(message.channel.id)) {
        if (message.author.bot) return;
        const allowed = isAllowedMediaMessage(message);
        if (!allowed) {
          await message.delete().catch(() => {});
        }
      }
    } catch (error) {
      console.error('Store messageCreate error:', error);
    }
  });

  client.on('guildMemberAdd', async (member) => {
    try {
      const config = getGuildConfig(member.guild.id);
      if (!config.autoRoleId) return;

      const role = await member.guild.roles.fetch(config.autoRoleId).catch(() => null);
      if (!role) return;
      await member.roles.add(role, 'Store auto role').catch(() => {});
    } catch (error) {
      console.error('Store auto role error:', error);
    }
  });

  const handleReactionRole = async (reaction, user, mode) => {
    try {
      if (user.bot) return;
      if (!reaction?.message?.guild) return;

      if (reaction.partial) await reaction.fetch().catch(() => null);
      if (reaction.message.partial) await reaction.message.fetch().catch(() => null);

      const guild = reaction.message.guild;
      const config = getGuildConfig(guild.id);
      const rr = config.reactionRole;
      if (!rr) return;

      if (rr.messageId !== reaction.message.id) return;
      const incomingEmoji = reaction.emoji.id ? `<${reaction.emoji.animated ? 'a' : ''}:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;
      if (String(incomingEmoji) !== String(rr.emoji)) return;

      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) return;

      if (mode === 'add') await member.roles.add(rr.roleId, 'Store reaction role add').catch(() => {});
      else await member.roles.remove(rr.roleId, 'Store reaction role remove').catch(() => {});
    } catch (error) {
      console.error('Store reaction role handler error:', error);
    }
  };

  client.on('messageReactionAdd', async (reaction, user) => handleReactionRole(reaction, user, 'add'));
  client.on('messageReactionRemove', async (reaction, user) => handleReactionRole(reaction, user, 'remove'));
}

module.exports = {
  name,
  aliases,
  execute,
  registerInteractionHandler,
  memberIsAdmin
};
