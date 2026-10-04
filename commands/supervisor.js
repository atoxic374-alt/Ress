const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  UserSelectMenuBuilder, MessageFlags
} = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { getResponsibilitiesSnapshot } = require('../utils/responsibilitiesStore');
const { getSupervisors, setSupervisors } = require('../utils/responsibilitySupervisors');

const sessions = new Map();
const encode = value => Buffer.from(String(value), 'utf8').toString('base64url');
const decode = value => Buffer.from(String(value), 'base64url').toString('utf8');

function isOwnerLike(source, BOT_OWNERS = []) {
  const id = source?.author?.id || source?.user?.id;
  const owners = Array.isArray(global.BOT_OWNERS) ? global.BOT_OWNERS : BOT_OWNERS;
  return Boolean(id && (owners.map(String).includes(String(id)) || source.guild?.ownerId === String(id)));
}
function options(responsibilities) {
  return Object.keys(responsibilities).slice(0, 25).map(name => ({ label: name.slice(0, 100), value: encode(name).slice(0, 100), description: 'اختيار المسؤولية لإدارة مشرفيها' }));
}
function choicePanel(responsibilities) {
  return {
    embeds: [colorManager.createEmbed().setTitle('Responsibility Supervisor').setDescription('**اختر المسؤولية التي تريد إدارة مشرفيها :**')],
    components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('supervisor_responsibility').setPlaceholder('Choose responsibility').addOptions(options(responsibilities)))]
  };
}
function managePanel(guildId, name, selected = []) {
  const current = getSupervisors(guildId, name);
  const list = current.userIds.length ? current.userIds.map(id => `<@${id}>`).join(' , ') : 'لا يوجد مشرفون معينون';
  const embed = colorManager.createEmbed().setTitle('Responsibility Supervisor').setDescription(`**المسؤولية : ${name}**\n**المشرفون : ${list}**\nاختر الأشخاص ثم استخدم Add أو Remove.`);
  const select = new UserSelectMenuBuilder().setCustomId(`supervisor_users_${encode(name)}`).setPlaceholder('اختر الأشخاص').setMinValues(1).setMaxValues(25);
  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`supervisor_add_${encode(name)}`).setLabel('Add').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`supervisor_remove_${encode(name)}`).setLabel('Remove').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('supervisor_back').setLabel('Back').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select), actions], selected };
}
function getSession(interaction) { return sessions.get(interaction.message?.id); }
function saveSelected(session, key, ids) { session.selected = session.selected || {}; session.selected[key] = ids.map(String); }

async function execute(message, args, context = {}) {
  if (!isOwnerLike(message, context.BOT_OWNERS)) return message.react('❌');
  const responsibilities = getResponsibilitiesSnapshot();
  if (!Object.keys(responsibilities).length) return message.reply('❌ **لا توجد مسؤوليات حالياً.**');
  const sent = await message.reply(choicePanel(responsibilities));
  sessions.set(sent.id, { userId: message.author.id, guildId: message.guild.id, selected: {} });
  setTimeout(() => sessions.delete(sent.id), 10 * 60 * 1000);
}

async function handleInteraction(interaction, context = {}) {
  const id = String(interaction.customId || '');
  if (!id.startsWith('supervisor_')) return false;
  const session = getSession(interaction);
  const owner = session?.userId || interaction.user.id;
  if (!isOwnerLike(interaction, context.BOT_OWNERS) && interaction.user.id !== owner) {
    await interaction.reply({ content: '❌ **هذا اللوح ليس متاحاً لك.**', flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
  }
  if (id.startsWith('supervisor_manage_')) {
    const name = decode(id.slice('supervisor_manage_'.length));
    if (!sessions.has(interaction.message.id)) sessions.set(interaction.message.id, { userId: interaction.user.id, guildId: interaction.guild.id, selected: {} });
    return interaction.update(managePanel(interaction.guild.id, name));
  }
  if (id === 'supervisor_responsibility') {
    const name = decode(interaction.values[0]);
    return interaction.update(managePanel(interaction.guild.id, name));
  }
  if (id === 'supervisor_back') return interaction.update(choicePanel(getResponsibilitiesSnapshot()));
  if (interaction.isUserSelectMenu() && id.startsWith('supervisor_users_')) {
    const key = id.slice('supervisor_users_'.length);
    const activeSession = session || (() => { const created = { userId: interaction.user.id, guildId: interaction.guild.id, selected: {} }; sessions.set(interaction.message.id, created); return created; })();
    saveSelected(activeSession, key, interaction.values);
    activeSession.selected[key] = interaction.values.map(String);
    return interaction.update(managePanel(interaction.guild.id, decode(key), interaction.values));
  }
  if (id.startsWith('supervisor_add_') || id.startsWith('supervisor_remove_')) {
    const adding = id.startsWith('supervisor_add_');
    const key = id.replace(/^supervisor_(?:add|remove)_/, '');
    const name = decode(key);
    const selected = session?.selected?.[key] || [];
    if (!selected.length) return interaction.reply({ content: '**اختر شخصاً واحداً على الأقل أولاً.**', flags: MessageFlags.Ephemeral });
    const current = getSupervisors(interaction.guild.id, name);
    const userIds = adding ? [...new Set([...current.userIds, ...selected])] : current.userIds.filter(uid => !selected.includes(uid));
    const changedUserIds = adding
      ? selected.filter(id => !current.userIds.includes(String(id)))
      : selected.filter(id => current.userIds.includes(String(id)));
    setSupervisors(interaction.guild.id, name, { userIds });

    // تأكيد التفاعل أولاً حتى لا تنتهي مهلة Discord أثناء تحديث رسالة Resp.
    await interaction.update(managePanel(interaction.guild.id, name));
    try {
      const client = context.client || global.client;
      const respCommand = client?.commands?.get('resp') || require('./resp.js');
      if (client && respCommand?.updateEmbedMessage) {
        await respCommand.updateEmbedMessage(client, interaction.guild.id);
      }

      for (const userId of changedUserIds) {
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (member) {
          await member.send({
            content: adding
              ? `**تم تعيينك مشرفًا على مسؤولية : ${name}** في سيرفر **${interaction.guild.name}**.`
              : `**تمت إزالة إشرافك عن مسؤولية : ${name}** في سيرفر **${interaction.guild.name}**.`
          }).catch(() => {});
        }
      }
    } catch (refreshError) {
      console.error('تعذر تحديث Embed المسؤوليات بعد تعديل المشرفين:', refreshError);
    }
    return;
  }
  return false;
}

module.exports = { name: 'مشرف', aliases: ['supervisor', 'مشرفين'], description: 'إدارة مشرفي المسؤوليات للأونرز فقط', execute, handleInteraction };
