const fs = require('fs');
const path = require('path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { memberIsAdmin } = require('./store.js');

const name = 'reply';
const aliases = ['رد'];

const dataPath = path.join(__dirname, '..', 'data', 'replyTriggers.json');

function readData() {
  try {
    if (!fs.existsSync(dataPath)) return {};
    return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch {
    return {};
  }
}

function saveData(data) {
  const dir = path.dirname(dataPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
}

function getGuildReplies(guildId) {
  const all = readData();
  if (!all[guildId]) {
    all[guildId] = { items: [] };
    saveData(all);
  }
  if (!Array.isArray(all[guildId].items)) all[guildId].items = [];
  return all[guildId].items;
}

function setGuildReplies(guildId, items) {
  const all = readData();
  all[guildId] = { items };
  saveData(all);
}

function normalizeKeyword(keyword) {
  return String(keyword || '').trim().toLowerCase();
}

function buildMainEmbed(guild) {
  const items = getGuildReplies(guild.id);
  const list = items.length
    ? items.slice(0, 20).map((x, i) => `**${i + 1}.** **الكلمة :** ${x.keyword}\n**الرد :** ${x.response}`).join('\n\n')
    : '**لا يوجد ردود مضافة حالياً**';

  return colorManager.createEmbed()
    .setTitle('Reply Manager')
    .setDescription(
      '**التحكم :**\n' +
      '**إضافة / إزالة / تعديل**\n\n' +
      '**الردود الحالية :**\n' +
      list
    )
    .setFooter({ text: 'عند كتابة الكلمة سيتم رد البوت مباشرة.' });
}

function buildMainButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('reply_add').setLabel('إضافة').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('reply_remove').setLabel('إزالة').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('reply_edit').setLabel('تعديل').setStyle(ButtonStyle.Primary)
    )
  ];
}

function buildAddModal(customId, title, withOldKeyword = false) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  const rows = [];

  if (withOldKeyword) {
    rows.push(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('old_keyword')
        .setLabel('الكلمة الحالية')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ));
  }

  rows.push(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('keyword')
      .setLabel(withOldKeyword ? 'الكلمة الجديدة' : 'الكلمة')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
  ));

  rows.push(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('response')
      .setLabel('الرد')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
  ));

  modal.addComponents(...rows);
  return modal;
}

function buildRemoveModal() {
  const modal = new ModalBuilder().setCustomId('reply_remove_modal').setTitle('إزالة رد');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('keyword')
      .setLabel('الكلمة المراد حذفها')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
  ));
  return modal;
}

async function resolveMentions(text, guild) {
  let out = String(text || '');

  out = out.replace(/\b(\d{17,20})\b/g, '<@$1>');

  const usernameMatches = [...out.matchAll(/(^|\s)@([\w.]{2,32})/g)];
  for (const match of usernameMatches) {
    const raw = match[0];
    const username = match[2].toLowerCase();
    const member = guild.members.cache.find(m =>
      (m.user.username && m.user.username.toLowerCase() === username) ||
      (m.displayName && m.displayName.toLowerCase() === username) ||
      (m.user.globalName && m.user.globalName.toLowerCase() === username)
    );
    if (member) {
      out = out.replace(raw, `${match[1]}<@${member.id}>`);
    }
  }

  return out;
}

async function execute(message, args, { BOT_OWNERS = [] }) {
  if (!memberIsAdmin(message.member, BOT_OWNERS)) {
    await message.react('❌');
    return;
  }

  await message.channel.send({
    embeds: [buildMainEmbed(message.guild)],
    components: buildMainButtons()
  });
}

function registerInteractionHandler(client) {
  if (client.__replyHandlersRegistered) return;
  client.__replyHandlersRegistered = true;

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.guild) return;

      if (interaction.isButton() && interaction.customId.startsWith('reply_')) {
        if (!memberIsAdmin(interaction.member, global.BOT_OWNERS || [])) {
          await interaction.reply({ content: '❌ هذا الأمر للإدارة فقط.', ephemeral: true });
          return;
        }

        if (interaction.customId === 'reply_add') {
          await interaction.showModal(buildAddModal('reply_add_modal', 'إضافة رد'));
          return;
        }
        if (interaction.customId === 'reply_remove') {
          await interaction.showModal(buildRemoveModal());
          return;
        }
        if (interaction.customId === 'reply_edit') {
          await interaction.showModal(buildAddModal('reply_edit_modal', 'تعديل رد', true));
          return;
        }
      }

      if (!interaction.isModalSubmit()) return;
      if (!interaction.customId.startsWith('reply_')) return;

      if (!memberIsAdmin(interaction.member, global.BOT_OWNERS || [])) {
        await interaction.reply({ content: '❌ هذا الأمر للإدارة فقط.', ephemeral: true });
        return;
      }

      const items = getGuildReplies(interaction.guild.id);

      if (interaction.customId === 'reply_add_modal') {
        const keyword = interaction.fields.getTextInputValue('keyword').trim();
        const responseRaw = interaction.fields.getTextInputValue('response').trim();

        if (!keyword || !responseRaw) {
          await interaction.reply({ content: '❌ الكلمة والرد مطلوبة.', ephemeral: true });
          return;
        }

        const normalized = normalizeKeyword(keyword);
        const exists = items.findIndex(x => normalizeKeyword(x.keyword) === normalized);
        const response = await resolveMentions(responseRaw, interaction.guild);

        if (exists >= 0) items[exists] = { keyword, response };
        else items.push({ keyword, response });

        setGuildReplies(interaction.guild.id, items);
        await interaction.reply({ content: '✅ تم حفظ الرد بنجاح.', ephemeral: true });

        const panel = await interaction.channel.messages.fetch(interaction.message?.id || '').catch(() => null);
        if (panel) await panel.edit({ embeds: [buildMainEmbed(interaction.guild)], components: buildMainButtons() }).catch(() => {});
        return;
      }

      if (interaction.customId === 'reply_remove_modal') {
        const keyword = interaction.fields.getTextInputValue('keyword').trim();
        const normalized = normalizeKeyword(keyword);
        const next = items.filter(x => normalizeKeyword(x.keyword) !== normalized);

        if (next.length === items.length) {
          await interaction.reply({ content: '❌ الكلمة غير موجودة.', ephemeral: true });
          return;
        }

        setGuildReplies(interaction.guild.id, next);
        await interaction.reply({ content: '✅ تم حذف الرد.', ephemeral: true });

        const panel = await interaction.channel.messages.fetch(interaction.message?.id || '').catch(() => null);
        if (panel) await panel.edit({ embeds: [buildMainEmbed(interaction.guild)], components: buildMainButtons() }).catch(() => {});
        return;
      }

      if (interaction.customId === 'reply_edit_modal') {
        const oldKeyword = interaction.fields.getTextInputValue('old_keyword').trim();
        const newKeyword = interaction.fields.getTextInputValue('keyword').trim();
        const responseRaw = interaction.fields.getTextInputValue('response').trim();

        const oldNorm = normalizeKeyword(oldKeyword);
        const idx = items.findIndex(x => normalizeKeyword(x.keyword) === oldNorm);
        if (idx < 0) {
          await interaction.reply({ content: '❌ الكلمة الحالية غير موجودة.', ephemeral: true });
          return;
        }

        const response = await resolveMentions(responseRaw, interaction.guild);
        items[idx] = { keyword: newKeyword, response };
        setGuildReplies(interaction.guild.id, items);

        await interaction.reply({ content: '✅ تم تعديل الرد.', ephemeral: true });

        const panel = await interaction.channel.messages.fetch(interaction.message?.id || '').catch(() => null);
        if (panel) await panel.edit({ embeds: [buildMainEmbed(interaction.guild)], components: buildMainButtons() }).catch(() => {});
      }
    } catch (error) {
      console.error('Reply interaction error:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ حدث خطأ أثناء التنفيذ.', ephemeral: true }).catch(() => {});
      }
    }
  });

  client.on('messageCreate', async (message) => {
    try {
      if (!message.guild || message.author.bot) return;
      const items = getGuildReplies(message.guild.id);
      if (!items.length) return;

      const content = String(message.content || '').trim().toLowerCase();
      if (!content) return;

      const match = items.find(x => {
        const keyword = normalizeKeyword(x.keyword);
        return keyword && (content === keyword || content.includes(keyword));
      });

      if (!match) return;

      await message.reply({
        content: match.response,
        allowedMentions: { parse: ['users', 'roles', 'everyone'] }
      }).catch(() => {});
    } catch (error) {
      console.error('Reply message handler error:', error);
    }
  });
}

module.exports = {
  name,
  aliases,
  execute,
  registerInteractionHandler
};
