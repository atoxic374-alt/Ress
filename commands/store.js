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
  StringSelectMenuBuilder
} = require('discord.js');
const colorManager = require('../utils/colorManager.js');

const name = 'store';
const aliases = ['ستور'];

const dataPath = path.join(__dirname, '..', 'data', 'storeSettings.json');
const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');

const tempFontUrls = new Map();
const tempReactionSets = new Map();

function ensureDataDir() {
  const dir = path.dirname(dataPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readStoreData() {
  try {
    if (!fs.existsSync(dataPath)) return {};
    return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
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
  return adminRoles.length > 0 && member.roles.cache.some(role => adminRoles.includes(role.id));
}

function getGuildConfig(guildId) {
  const all = readStoreData();
  if (!all[guildId]) {
    all[guildId] = {
      autoRoleId: null,
      fontChannels: {},
      autoReactions: {}
    };
    saveStoreData(all);
  }
  return all[guildId];
}

function setGuildConfig(guildId, updater) {
  const all = readStoreData();
  if (!all[guildId]) {
    all[guildId] = {
      autoRoleId: null,
      fontChannels: {},
      autoReactions: {}
    };
  }
  updater(all[guildId]);
  saveStoreData(all);
}

function formatConfig(config) {
  const fontLines = Object.entries(config.fontChannels || {});
  const reactionLines = Object.entries(config.autoReactions || {});

  return {
    fontText: fontLines.length
      ? fontLines.map(([channelId, url], i) => `**${i + 1}.** <#${channelId}>\n**الرابط :** ${url}`).join('\n\n')
      : '**غير محدد**',
    reactionText: reactionLines.length
      ? reactionLines.map(([channelId, emojis], i) => `**${i + 1}.** <#${channelId}>\n**الإيموجيات :** ${emojis.join(' ')}`).join('\n\n')
      : '**غير محدد**',
    autoRoleText: config.autoRoleId ? `<@&${config.autoRoleId}>` : '**غير محدد**'
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
      `${view.autoRoleText}`
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
  const customRegex = /<a?:[^:>]{2,32}:\d{17,20}>/g;
  const custom = input.match(customRegex) || [];
  const removedCustom = input.replace(customRegex, ' ');
  const unicode = removedCustom.split(/\s+/).map(x => x.trim()).filter(Boolean);
  return [...custom, ...unicode].slice(0, 10);
}

function normalizeReactEmoji(emoji) {
  return String(emoji || '').trim();
}

function registerInteractionHandler(client) {
  if (client.__storeHandlersRegistered) return;
  client.__storeHandlersRegistered = true;

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.guild) return;

      const member = interaction.member;
      const isAdmin = memberIsAdmin(member, global.BOT_OWNERS || []);

      const adminOnly = [
        'store_font_btn', 'store_reaction_btn', 'store_autorole_btn', 'store_remove_btn', 'store_refresh_btn',
        'store_font_channels', 'store_react_channels', 'store_autorole_role', 'store_remove_type',
        'store_remove_font_channels', 'store_remove_react_channels'
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
              { label: 'إزالة الرول التلقائي', value: 'autorole', description: 'إلغاء إعطاء الرول عند الدخول' }
            ])
        );
        await interaction.reply({ content: '**حدد الإعداد الذي تريد حذفه :**', components: [row], ephemeral: true });
        return;
      }

      if (interaction.isStringSelectMenu() && interaction.customId === 'store_remove_type') {
        const selected = interaction.values[0];
        if (selected === 'autorole') {
          setGuildConfig(interaction.guild.id, cfg => { cfg.autoRoleId = null; });
          await interaction.update({ content: '✅ تم حذف الرول التلقائي.', components: [] });
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
        setGuildConfig(interaction.guild.id, cfg => {
          for (const channelId of interaction.values) delete cfg.fontChannels[channelId];
        });
        await interaction.update({ content: '✅ تم حذف إعداد الخط من الشاتات المحددة.', components: [] });
        return;
      }

      if (interaction.isChannelSelectMenu() && interaction.customId === 'store_remove_react_channels') {
        setGuildConfig(interaction.guild.id, cfg => {
          for (const channelId of interaction.values) delete cfg.autoReactions[channelId];
        });
        await interaction.update({ content: '✅ تم حذف إعداد الرياكشن من الشاتات المحددة.', components: [] });
        return;
      }

      if (interaction.isRoleSelectMenu() && interaction.customId === 'store_autorole_role') {
        const roleId = interaction.values[0];
        setGuildConfig(interaction.guild.id, cfg => { cfg.autoRoleId = roleId; });
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

        setGuildConfig(interaction.guild.id, cfg => {
          for (const channelId of interaction.values) {
            cfg.fontChannels[channelId] = imageUrl;
          }
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

        setGuildConfig(interaction.guild.id, cfg => {
          for (const channelId of interaction.values) {
            cfg.autoReactions[channelId] = emojis;
          }
        });
        tempReactionSets.delete(key);
        await interaction.update({ content: '✅ تم حفظ الرياكشن التلقائي للشاتات المحددة.', components: [] });
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
}

module.exports = {
  name,
  aliases,
  execute,
  registerInteractionHandler,
  memberIsAdmin
};
