const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  UserSelectMenuBuilder, MessageFlags
} = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { getResponsibilitiesSnapshot } = require('../utils/responsibilitiesStore');
const { getSupervisors, setSupervisors } = require('../utils/responsibilitySupervisors');
const { dbManager } = require('../utils/database.js');

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
    new ButtonBuilder().setCustomId(`supervisor_add_${encode(name)}`).setLabel('إضافة إشراف').setStyle(ButtonStyle.Success).setEmoji('<:emoji_91:1442990316549312582>'),
    new ButtonBuilder().setCustomId(`supervisor_remove_${encode(name)}`).setLabel('إزالة إشراف').setStyle(ButtonStyle.Danger).setEmoji('<:emoji_90:1442990214925520976>'),
    new ButtonBuilder().setCustomId('supervisor_back').setLabel('Back').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select), actions], selected };
}
function memberPanel(member) {
  const embed = colorManager.createEmbed()
    .setTitle('**إدارة إشراف العضو**')
    .setDescription(`**العضو المستهدف:** ${member}\n**الأيدي:** \`${member.id}\`\n\n**اختر الإجراء المطلوب:**`)
    .setThumbnail(member.user.displayAvatarURL({ size: 128 }));
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`supervisor_member_add_${member.id}`).setLabel('إضافة إشراف').setStyle(ButtonStyle.Success).setEmoji('<:emoji_91:1442990316549312582>'),
    new ButtonBuilder().setCustomId(`supervisor_member_remove_${member.id}`).setLabel('إزالة إشراف').setStyle(ButtonStyle.Danger).setEmoji('<:emoji_90:1442990214925520976>')
  );
  return { embeds: [embed], components: [row] };
}
function getSession(interaction) { return sessions.get(interaction.message?.id); }
function saveSelected(session, key, ids) { session.selected = session.selected || {}; session.selected[key] = ids.map(String); }

async function applyMemberSupervisorAction(interaction, session, adding, selectedNames) {
  const target = await interaction.guild.members.fetch(session.targetId).catch(() => null);
  if (!target) return interaction.update({ content: '❌ **فشل التحديث: العضو غادر السيرفر.**', embeds: [], components: [] });
  const all = await dbManager.getResponsibilities();
  const changed = [];
  const roleIds = new Set();
  for (const name of selectedNames) {
    const config = all?.[name];
    if (!config) continue;
    const current = getSupervisors(interaction.guild.id, name);
    const already = current.userIds.includes(String(target.id));
    if (adding && already || !adding && !already) continue;
    setSupervisors(interaction.guild.id, name, {
      userIds: adding ? [...new Set([...current.userIds, String(target.id)])] : current.userIds.filter(id => String(id) !== String(target.id)),
      roleIds: current.roleIds
    });
    for (const roleId of [...(config.roles || []), ...(config.roleId ? [config.roleId] : [])]) roleIds.add(String(roleId));
    changed.push(name);
  }
  if (adding) {
    await Promise.all([...roleIds].map(async roleId => {
      if (!target.roles.cache.has(roleId)) await target.roles.add(roleId, 'إضافة رول إشراف المسؤولية').catch(() => {});
    }));
  } else {
    const latest = await dbManager.getResponsibilities();
    const removable = [...roleIds].filter(roleId => !Object.entries(latest || {}).some(([name, config]) => {
      const direct = (config?.responsibles || []).map(String).includes(String(target.id));
      const supervisor = getSupervisors(interaction.guild.id, name).userIds.includes(String(target.id));
      const roles = [...(config?.roles || []), ...(config?.roleId ? [config.roleId] : [])].map(String);
      return roles.includes(roleId) && (direct || supervisor);
    }));
    if (!global.responsibilityRoleSyncBypass) global.responsibilityRoleSyncBypass = new Set();
    await Promise.all(removable.map(async roleId => {
      if (!target.roles.cache.has(roleId)) return;
      const key = `${interaction.guild.id}:${target.id}:${roleId}`;
      global.responsibilityRoleSyncBypass.add(key);
      setTimeout(() => global.responsibilityRoleSyncBypass?.delete(key), 30000);
      await target.roles.remove(roleId, 'إزالة رول إشراف المسؤولية').catch(() => {});
    }));
  }
  if (global.client) global.client.emit('responsibilityUpdate');
  const verb = adding ? 'إضافة' : 'إزالة';
  return interaction.update({ content: changed.length ? `✅ **تم ${verb} الإشراف بنجاح.**` : `⚠️ **لم يتم ${verb} أي إشراف جديد.**`, embeds: [], components: [] });
}

async function execute(message, args, context = {}) {
  if (!isOwnerLike(message, context.BOT_OWNERS)) return message.react('❌');
  const responsibilities = getResponsibilitiesSnapshot();
  if (!Object.keys(responsibilities).length) return message.reply('❌ **لا توجد مسؤوليات حالياً.**');
  const target = message.mentions.members.first() || await message.guild.members.fetch(args[0]).catch(() => null);
  if (target) {
    const sent = await message.reply(memberPanel(target));
    sessions.set(sent.id, { userId: message.author.id, guildId: message.guild.id, targetId: target.id, selected: {} });
    setTimeout(() => sessions.delete(sent.id), 10 * 60 * 1000);
    return;
  }
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
  if (id.startsWith('supervisor_member_add_') || id.startsWith('supervisor_member_remove_')) {
    const adding = id.startsWith('supervisor_member_add_');
    const prefix = `supervisor_member_${adding ? 'add' : 'remove'}_`;
    const targetId = id.slice(prefix.length);
    const all = await dbManager.getResponsibilities();
    const names = Object.keys(all || {}).filter(name => {
      const has = getSupervisors(interaction.guild.id, name).userIds.includes(String(targetId));
      return adding ? !has : has;
    });
    if (!names.length) return interaction.update({ content: adding ? '⚠️ **العضو مشرف في جميع المسؤوليات.**' : '⚠️ **العضو لا يملك إشرافًا لإزالته.**', embeds: [], components: [] });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`supervisor_member_select_${adding ? 'add' : 'remove'}_${targetId}`)
      .setPlaceholder(adding ? 'اختر المسؤوليات المراد إضافتها' : 'اختر المسؤوليات المراد إزالتها')
      .setMinValues(1).setMaxValues(Math.min(names.length, 25))
      .addOptions(names.slice(0, 25).map(name => ({ label: name.slice(0, 100), value: name, description: `${adding ? 'إضافة' : 'إزالة'} إشراف ${name}` })));
    return interaction.update({ content: adding ? '**اختر المسؤوليات المراد منح إشرافها للعضو:**' : '**اختر المسؤوليات المراد سحب إشرافها من العضو:**', embeds: [], components: [new ActionRowBuilder().addComponents(menu)] });
  }
  if (id.startsWith('supervisor_member_select_') && interaction.isStringSelectMenu()) {
    const match = id.match(/^supervisor_member_select_(add|remove)_(\d+)$/);
    if (!match) return true;
    const sessionForMember = session || { userId: interaction.user.id, guildId: interaction.guild.id, targetId: match[2], selected: {} };
    sessionForMember.targetId = match[2];
    return applyMemberSupervisorAction(interaction, sessionForMember, match[1] === 'add', interaction.values);
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

    // مزامنة الرولات في لوحة المسؤولية القديمة أيضًا، حتى لا يختلف سلوكها
    // عن أمر مشرف الجديد. نعالج الأعضاء المحددين فقط وبالتوازي.
    const roleConfig = (await dbManager.getResponsibilities())?.[name] || {};
    const roleIds = [...new Set([...(roleConfig.roles || []), ...(roleConfig.roleId ? [roleConfig.roleId] : [])].map(String))];
    if (roleIds.length) {
      if (adding) {
        await Promise.all(selected.map(async userId => {
          const member = await interaction.guild.members.fetch(userId).catch(() => null);
          if (!member) return;
          await Promise.all(roleIds.filter(roleId => !member.roles.cache.has(roleId)).map(roleId => member.roles.add(roleId, 'إضافة رول إشراف المسؤولية').catch(() => {})));
        }));
      } else {
        const latest = await dbManager.getResponsibilities();
        if (!global.responsibilityRoleSyncBypass) global.responsibilityRoleSyncBypass = new Set();
        await Promise.all(selected.map(async userId => {
          const member = await interaction.guild.members.fetch(userId).catch(() => null);
          if (!member) return;
          for (const roleId of roleIds) {
            const stillAuthorized = Object.entries(latest || {}).some(([respName, config]) => {
              const roles = [...(config?.roles || []), ...(config?.roleId ? [config.roleId] : [])].map(String);
              return roles.includes(roleId)
                && ((config?.responsibles || []).map(String).includes(String(userId))
                  || getSupervisors(interaction.guild.id, respName).userIds.includes(String(userId)));
            });
            if (!stillAuthorized && member.roles.cache.has(roleId)) {
              const bypassKey = `${interaction.guild.id}:${userId}:${roleId}`;
              global.responsibilityRoleSyncBypass.add(bypassKey);
              setTimeout(() => global.responsibilityRoleSyncBypass?.delete(bypassKey), 30000);
              await member.roles.remove(roleId, 'إزالة رول إشراف المسؤولية').catch(() => {});
            }
          }
        }));
      }
    }

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
