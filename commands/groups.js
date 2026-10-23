const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, LabelBuilder, ModalBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder, TextDisplayBuilder, SectionBuilder, ContainerBuilder, ThumbnailBuilder, UserSelectMenuBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
const router = require('../utils/interactionRouter');
const gm = require('../utils/groupManager');
const colorManager = require('../utils/colorManager');
const tempVoice = require('./temp');
const { componentsV2Payload, colorToNumber } = require('../utils/structuredContainer');
const { renderMembers, renderInfo, renderTopGroups, renderMyRank } = require('../utils/groupRenderer');
const { handleInternalMessage, leaveGroupMember } = require('../utils/groupInternal');
const name = 'groups';
const aliases = ['group', 'قروب', 'قروبات'];
let registered = false;
const locks = new Set();
function safe(s, n=100) { return String(s||'').replace(/[\u0000-\u001f]/g,'').slice(0,n); }
function isOwner(client, member) { return gm.isOwner(client, member); }
function button(id, label, style=ButtonStyle.Secondary, emoji) { const b=new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style); if(emoji)b.setEmoji(emoji); return b; }
function groupThumb(guild) {
  try {
    return guild?.iconURL?.({ extension: 'png', size: 128 })
      || guild?.client?.user?.displayAvatarURL?.({ extension: 'png', size: 128 })
      || undefined;
  } catch { return undefined; }
}
function baseContainer(guild, title, description='', color='#5865F2') { const c=new ContainerBuilder().setAccentColor(colorToNumber(colorManager.getColor?.() || color || '#5865F2')); const text=[]; if(title)text.push(new TextDisplayBuilder().setContent(`## ${title}`)); if(description)text.push(new TextDisplayBuilder().setContent(description)); if(groupThumb(guild)){ const s=new SectionBuilder().addTextDisplayComponents(text).setThumbnailAccessory(new ThumbnailBuilder().setURL(groupThumb(guild))); c.addSectionComponents(s); } else text.forEach(t=>c.addTextDisplayComponents(t)); return c; }
const RULE_METRICS = Object.freeze([
  ['messages', 'الرسائل', 'messages counted in group text channels', 100],
  ['voice_ms', 'الصوت', 'milliseconds spent in group voice channels', 3600000],
  ['reactions', 'التفاعلات', 'reactions added to messages', 10]
]);
function rulesPayload(guild, rules = []) {
  const byMetric = new Map(rules.map(rule => [String(rule.metric), rule]));
  const c = baseContainer(guild, 'قواعد القروبات', 'عرض وتعديل وتفعيل حدود ونقاط الرسائل والصوت والتفاعلات.');
  for (const [metric, label, description, defaultThreshold] of RULE_METRICS) {
    const rule = byMetric.get(metric);
    const enabled = Number(rule?.enabled) === 1;
    const threshold = Number(rule?.threshold) || defaultThreshold;
    const points = Number(rule?.points) || 1;
    c.addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${label}**\n${description}\nThreshold: **${threshold.toLocaleString()}** | Points: **${points}** | Status: **${enabled ? 'مفعل' : 'متوقف'}**`))
      .setButtonAccessory(button(`groups_rules:edit:${metric}`, 'تعديل', ButtonStyle.Primary)));
    c.addActionRowComponents(new ActionRowBuilder().addComponents(button(`groups_rules:toggle:${metric}`, enabled ? 'تعطيل' : 'تفعيل', enabled ? ButtonStyle.Danger : ButtonStyle.Success)));
  }
  return componentsV2Payload(c);
}

function setupIssueLabel(issue) {
  const labels = {
    chatMode: 'اختر نمط الشات.',
    textCategoryId: 'حدد كاتاقوري النص/الثريدات.',
    voiceCategoryId: 'حدد كاتاقوري الصوت.',
    logChannelId: 'روم السجلات غير صالح أو لم يعد موجودًا.',
    topChannelId: 'روم لوحة الترتيب غير صالح أو لم يعد موجودًا.',
    adminControlChannelId: 'روم لوحة الإدارة غير صالح أو لم يعد موجودًا.',
    memberControlChannelId: 'روم لوحة الأعضاء غير صالح أو لم يعد موجودًا.',
    musicChannelId: 'روم مصدر الموسيقى غير صالح أو لم يعد موجودًا.',
    mainRolePosition: 'اختر رتبة رئيسية أعلى من @everyone.',
    'permission:BOT_MEMBER': 'تعذر قراءة صلاحيات البوت في السيرفر.',
    'permission:ManageChannels': 'امنح البوت صلاحية Manage Channels.',
    'permission:ManageRoles': 'امنح البوت صلاحية Manage Roles.',
    'permission:ManageMessages': 'امنح البوت صلاحية Manage Messages لتفعيل تنظيف الرسائل.',
    'permission:ModerateMembers': 'امنح البوت صلاحية Moderate Members لتفعيل العقوبات.',
    'permission:MoveMembers': 'امنح البوت صلاحية Move Members لفصل الأعضاء من الصوت.'
  };
  if (labels[issue]) return labels[issue];
  if (issue.startsWith('permission:')) return `امنح البوت الصلاحية ${issue.slice('permission:'.length)}.`;
  if (issue.startsWith('categoryPermission:')) {
    const [, key, permission] = issue.split(':');
    const category = key === 'textCategoryId' ? 'كاتاقوري النص' : 'كاتاقوري الصوت';
    return `تأكد من أن البوت يملك ${permission} في ${category}.`;
  }
  if (issue.startsWith('channelPermission:')) {
    const [, key, permission] = issue.split(':');
    const channel = ({ musicChannelId: 'روم مصدر الموسيقى', logChannelId: 'روم السجلات', topChannelId: 'روم الترتيب', adminControlChannelId: 'روم تحكم الإدارة', memberControlChannelId: 'روم تحكم الأعضاء' })[key] || 'الروم المحدد';
    return `تأكد من أن البوت يملك ${permission} في ${channel}.`;
  }
  if (issue.startsWith('roleHierarchy:')) return `ارفع رتبة البوت فوق الرتبة <@&${issue.slice('roleHierarchy:'.length)}>.`;
  if (issue.startsWith('role:')) return `الرتبة <@&${issue.slice('role:'.length)}> غير موجودة.`;
  return `راجع الإعداد: ${issue}.`;
}

function setupPayloads(guild, settings) {
  const status = settings.enabled ? 'مفعل' : 'متوقف';
  const roleMention = id => id ? `<@&${id}>` : 'غير محدد';
  const channelMention = id => id ? `<#${id}>` : 'غير محدد';
  const managerCount = Number(settings.systemUsers?.length || 0) + Number(settings.systemRoles?.length || 0);
  const chatMode = settings.chatMode === 'threads' ? 'ثريدات' : settings.chatMode === 'channels' ? 'رومات مستقلة' : 'غير محدد';
  const issues = gm.validateConfig(guild, settings);
  const readiness = issues.length ? `الإعداد غير مكتمل (${issues.length}):\n${issues.slice(0, 6).map(setupIssueLabel).join('\n')}${issues.length > 6 ? '\n... استخدم زر تدقيق الإعداد لعرض الباقي.' : ''}` : 'الإعداد جاهز لإنشاء القروبات.';
  const summary = `Status : ${status}\nReadiness : ${readiness}\nSystem Managers : ${managerCount} عضو/رول\nChat Mode : ${chatMode}\nText Category : ${channelMention(settings.textCategoryId)}\nVoice Category : ${channelMention(settings.voiceCategoryId)}\nTop Channel : ${channelMention(settings.topChannelId)}\nAdmin Control Channel : ${channelMention(settings.adminControlChannelId)}\nMember Control Channel : ${channelMention(settings.memberControlChannelId)}\nMain Role : ${roleMention(settings.mainRoleId)}\nLeader Role : ${roleMention(settings.leaderRoleId)}\nManager Role : ${roleMention(settings.managerRoleId)}\nMusic Source : ${channelMention(settings.musicChannelId)}\nLog Channel : ${channelMention(settings.logChannelId)}\nPoints Scope : ${settings.countAllChannels ? 'كل الرومات' : 'رومات القروبات فقط'}\nExtra Permissions : ${settings.extraPermissions ? 'مفعلة' : 'متوقفة'}\nPoint Rules : اضغط على زر قواعد النقاط للتفاصيل`;
  const sections = [
    ['حالة نظام القروبات', 'تشغيل أو إيقاف نظام القروبات', 'groups_setup:toggle'],
    ['مسؤولو النظام', 'إضافة أو إزالة مسؤولي النظام', 'groups_setup:managers'],
    ['Chat Mode', 'ثريدات أو رومات مستقلة', 'groups_setup:chatmode'],
    ['Text Category', 'تحديد كاتوقري النص أو الثريدات', 'groups_setup:textcat'],
    ['Voice Category', 'تحديد كاتوقري الفويس', 'groups_setup:voicecat'],
    ['Top Channel', 'تحديد الروم الثابتة لإرسال لوحة توب القروبات', 'groups_setup:topchannel'],
    ['Admin Control Channel', 'تحديد الروم الثابتة لإرسال لوحة تحكم الإدارة', 'groups_setup:adminchannel'],
    ['Member Control Channel', 'تحديد الروم الثابتة لإرسال لوحات تحكم أعضاء القروبات', 'groups_setup:memberchannel'],
    ['Main Role', 'الرول الذي تنشأ تحته رولات القروبات تلقائيًا', 'groups_setup:mainrole'],
    ['Music Source', 'تحديد روم مصدر الميوزك عند إنشاء القروب', 'groups_setup:music'],
    ['Log Channel', 'إرسال لوقات القروبات هنا', 'groups_setup:log'],
    ['Leader Role', 'الرول الذي يأخذه مالك القروب', 'groups_setup:leaderrole'],
    ['Manager Role', 'الرول الذي يأخذه مسؤول القروب', 'groups_setup:managerrole'],
    ['Points Scope', 'كل الرومات أو رومات القروبات', 'groups_setup:scope'],
    ['الصلاحيات الإضافية', 'تفعيل المسح وأدوات الإدارة', 'groups_setup:extra'],
    ['Point Rules', 'تخصيص قواعد نقاط القروبات', 'groups_setup:rules']
  ];
  const make = (title, items, includeSummary) => {
    const c = includeSummary
      ? baseContainer(guild, title, summary)
      : new ContainerBuilder().setAccentColor(colorToNumber(colorManager.getColor?.() || '#5865F2'));
    for (const [label, desc, id] of items) c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${label}**\n${desc}`)).setButtonAccessory(button(id, 'فتح')));
    if (includeSummary) c.addActionRowComponents(new ActionRowBuilder().addComponents(button('groups_setup:audit', 'تدقيق الإعداد', ButtonStyle.Primary), button('groups_setup:clear', 'مسح قيمة', ButtonStyle.Secondary)));
    return componentsV2Payload(c);
  };
  return [make('إعدادات القروبات', sections.slice(0, 8), true), make('', sections.slice(8), false)];
}

const setupPanels = new Map();
const setupPanelLocks = new Map();
async function hydrateSetupReferences(guild, settings) {
  if (!guild.members?.me) await guild.members?.fetchMe?.().catch(() => null);
  const channelIds = ['textCategoryId', 'voiceCategoryId', 'musicChannelId', 'logChannelId', 'topChannelId', 'adminControlChannelId', 'memberControlChannelId'];
  const roleIds = ['mainRoleId', 'leaderRoleId', 'managerRoleId'];
  await Promise.all(channelIds.map(key => settings[key] && !guild.channels.cache.has(settings[key]) ? guild.channels.fetch(settings[key]).catch(() => null) : null));
  await Promise.all(roleIds.map(key => settings[key] && !guild.roles.cache.has(settings[key]) ? guild.roles.fetch(settings[key]).catch(() => null) : null));
}
function rememberSetupPanel(guildId, channelId, first, second) {
  const entry = { guildId: String(guildId), channelId: String(channelId), first, second, touchedAt: Date.now() };
  setupPanels.set(`${entry.guildId}:${entry.channelId}`, entry);
  if (setupPanels.size > 100) setupPanels.delete(setupPanels.keys().next().value);
  return entry;
}
function findSetupPanel(message, guildId, channelId) {
  for (const entry of setupPanels.values()) if (entry.first?.id === message?.id || entry.second?.id === message?.id) return entry;
  return setupPanels.get(`${String(guildId)}:${String(channelId)}`) || null;
}
function collectComponentCustomIds(value, ids = new Set(), visited = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || visited.has(value) || depth > 20) return ids;
  visited.add(value);
  if (typeof value.customId === 'string') ids.add(value.customId);
  if (typeof value.custom_id === 'string') ids.add(value.custom_id);
  if (typeof value.toJSON === 'function') {
    try {
      const json = value.toJSON();
      if (json && json !== value) collectComponentCustomIds(json, ids, visited, depth + 1);
    } catch {}
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    if (child && typeof child === 'object') collectComponentCustomIds(child, ids, visited, depth + 1);
  }
  return ids;
}
async function recoverSetupPanel(channel, guild) {
  const messages = await channel?.messages?.fetch?.({ limit: 100 }).catch(() => null);
  if (!messages) return null;
  const botId = guild.client?.user?.id;
  const panels = [...messages.values()].map(message => ({
    message,
    ids: collectComponentCustomIds(message.components || [])
  })).filter(({ message, ids }) =>
    (!botId || message.author?.id === botId) && [...ids].some(id => id.startsWith('groups_setup:'))
  ).sort((a, b) => Number(a.message.createdTimestamp || 0) - Number(b.message.createdTimestamp || 0));
  const firstPanels = panels.filter(({ ids }) => ids.has('groups_setup:toggle'));
  const secondPanels = panels.filter(({ ids }) => ids.has('groups_setup:mainrole'));
  const first = firstPanels[firstPanels.length - 1]?.message || null;
  const second = secondPanels[secondPanels.length - 1]?.message || null;
  return first || second ? rememberSetupPanel(guild.id, channel.id, first, second) : null;
}
async function refreshSetupPanel(interaction, settings) {
  settingsCache?.delete(String(interaction.guild.id));
  await hydrateSetupReferences(interaction.guild, settings);
  const entry = findSetupPanel(interaction.message, interaction.guild.id, interaction.channelId)
    || await recoverSetupPanel(interaction.channel, interaction.guild);
  if (!entry) return;
  const payloads = setupPayloads(interaction.guild, settings);
  await entry.first?.edit(payloads[0]).catch(() => {});
  await entry.second?.edit(payloads[1]).catch(() => {});
  entry.touchedAt = Date.now();
}
async function sendSetupPanel(channel, guild, settings) {
  const key = `${guild.id}:${channel.id}`;
  if (setupPanelLocks.has(key)) return setupPanelLocks.get(key);
  const work = (async () => {
    await hydrateSetupReferences(guild, settings);
    const payloads = setupPayloads(guild, settings);
    const first = await channel.send(payloads[0]);
    const second = await channel.send(payloads[1]);
    rememberSetupPanel(guild.id, channel.id, first, second);
    return first;
  })();
  setupPanelLocks.set(key, work);
  try { return await work; } finally { setupPanelLocks.delete(key); }
}
function controlPayload(guild) {
  const c = baseContainer(guild, 'إدارة القروبات', '');
  const items = [
    ['إنشاء', 'إنشاء قروب جديد', 'groups_admin:create', ButtonStyle.Secondary, '<:emoji_33:1465383525644501238>'],
    ['استيراد', 'ربط عناصر Discord الموجودة بقروب', 'groups_admin:import', ButtonStyle.Secondary, '<:emoji_30:1465383419641856233>'],
    ['معلومات', 'عرض تفاصيل القروب', 'groups_admin:info', ButtonStyle.Secondary, '<:emoji_33:1465383582292771025>'],
    ['تعديل', 'تعديل إعدادات القروب', 'groups_admin:edit', ButtonStyle.Secondary, '<:emoji_35:1465383704993202452>'],
    ['حذف', 'حذف قروب مُدار', 'groups_admin:delete', ButtonStyle.Danger, '<:emoji_21:1465336647477493894>'],
    ['تصفير', 'تصفير نقاط قروب واحد', 'groups_admin:reset', ButtonStyle.Danger, '<:emoji_34:1465383644339241073>'],
    ['تصفير الكل', 'تصفير نقاط كل القروبات', 'groups_admin:resetall', ButtonStyle.Danger, '<:emoji_26:1465373714060415180>']
  ];
  for (const [label, description, id, style, emoji] of items) {
    c.addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${label}**\n${description}`))
      .setButtonAccessory(button(id, label, style, emoji)));
  }
  return componentsV2Payload(c);
}
async function sendAdminControlPanel(channel, guild) {
  const payload = controlPayload(guild);
  const messages = await channel?.messages?.fetch?.({ limit: 100 }).catch(() => null);
  const botId = guild?.client?.user?.id;
  const existing = messages && [...messages.values()].filter(message =>
    (!botId || message.author?.id === botId) && JSON.stringify(message.components || []).includes('groups_admin:')
  ).sort((a, b) => Number(a.createdTimestamp || 0) - Number(b.createdTimestamp || 0)).pop();
  if (existing?.edit) {
    const edited = await existing.edit(payload).catch(() => null);
    if (edited) return edited;
  }
  return channel.send(payload);
}
function selectPayload(guild, title, description, customId, options) { const c=baseContainer(guild,title,description); const menu=new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('اختر خيارًا').setMinValues(1).setMaxValues(1).addOptions(options); c.addActionRowComponents(new ActionRowBuilder().addComponents(menu)); return componentsV2Payload(c); }
const { responsePayload } = require('../utils/groupResponses');
function replyMessage(message, payload) { return message.reply(responsePayload(typeof payload === 'string' ? { content: payload } : payload)); }
async function reply(interaction, payload, ephemeral=true) { const data=responsePayload({...payload,allowedMentions:{parse:[]}}); if(interaction.deferred&&!interaction.replied)return interaction.editReply(data); if(interaction.replied)return interaction.followUp({...data,ephemeral}); return interaction.reply({...data,ephemeral}); }
async function deny(interaction, message='لا تملك صلاحية استخدام هذه العملية.') { return reply(interaction,{content:message}); }
function setupConfirmation(interaction, title, text) { const c = baseContainer(interaction.guild, title, `**- ${safe(text, 300)} **`); return componentsV2Payload(c); }
async function checkSystem(interaction) { const settings=await gm.getSettings(interaction.guild.id); if(!gm.canManageSystem(interaction.client,settings,interaction.member)){await deny(interaction,'هذه العملية مخصصة لمسؤولي نظام القروبات ومالك السيرفر.');return null;} return settings; }
function musicResultMessage(result) { if(!result) return 'لم يتم تنفيذ الميوزك.'; if(result.ok) return result.alreadyPresent ? `بوت الأغاني ${result.musicBot.user.username} موجود بالفعل في الروم.` : `تم سحب بوت الأغاني ${result.musicBot.user.username} إلى الروم.`; const messages={MUSIC_CHANNEL_NOT_CONFIGURED:'لم يتم تحديد روم مصدر الميوزك.',INVALID_MUSIC_CHANNEL:'روم مصدر الميوزك غير صالح.',MUSIC_BOT_NOT_FOUND:'لم يتم العثور على بوت أغاني معروف في روم المصدر.',AMBIGUOUS_SOURCE_BOTS:'يوجد أكثر من بوت أغاني في المصدر؛ لم يتم اختيار بوت عشوائياً.',AMBIGUOUS_TARGET_BOTS:'يوجد أكثر من بوت أغاني في الروم الهدف؛ لم يتم تغيير أي بوت.',MISSING_PERMISSIONS:`صلاحيات البوت ناقصة : ${result.error||'غير معروفة'}`,MOVE_FAILED:'تعذر نقل بوت الأغاني حالياً.',TARGET_IS_MUSIC_CHANNEL:'الروم الهدف هو روم المصدر نفسه.'}; return messages[result.code]||'تعذر تنفيذ Music بأمان.'; }
function isGroupMember(group, userId) {
  const id = String(userId || '');
  return Boolean(id && (String(group?.owner_id) === id || group?.memberIds?.includes(id) || group?.managerIds?.includes(id)));
}
function selectMemberGroup(groups, userId, channelId, requestedGroupId = null) {
  const list = Array.isArray(groups) ? groups : [];
  const requested = requestedGroupId == null ? null : list.find(group => String(group.id) === String(requestedGroupId));
  if (requested && (isGroupMember(requested, userId) || gm.channelBelongs(requested, channelId))) return requested;
  return list.find(group => gm.channelBelongs(group, channelId) && isGroupMember(group, userId))
    || list.find(group => isGroupMember(group, userId)) || null;
}
function topGroupsButtons() {
  return [new ActionRowBuilder().addComponents(
    button('groups_top:rank', 'ترتيبي', ButtonStyle.Primary),
    button('groups_top:group', 'قروبي', ButtonStyle.Secondary),
    button('groups_top:manage', 'إدارة', ButtonStyle.Secondary)
  )];
}
function topManagePayload(guild) {
  const c = baseContainer(guild, 'إدارة', 'إدارة النقاط اليدوية للقروبات والأعضاء.');
  const actions = [
    ['Add Group Pts', 'groups_bonus:group-add', ButtonStyle.Success, '<:emoji_30:1465383419641856233>'],
    ['Remove Group Pts', 'groups_bonus:group-remove', ButtonStyle.Danger, '<:emoji_21:1465336647477493894>'],
    ['Add All Pts', 'groups_bonus:all-add', ButtonStyle.Success, '<:emoji_30:1465383419641856233>'],
    ['Remove All Pts', 'groups_bonus:all-remove', ButtonStyle.Danger, '<:emoji_21:1465336647477493894>'],
    ['Add Member Pts', 'groups_bonus:member-add', ButtonStyle.Success, '<:emoji_30:1465383419641856233>'],
    ['Remove Member Pts', 'groups_bonus:member-remove', ButtonStyle.Danger, '<:emoji_21:1465336647477493894>']
  ];
  for (let i = 0; i < actions.length; i += 2) {
    c.addActionRowComponents(new ActionRowBuilder().addComponents(
      ...actions.slice(i, i + 2).map(([label, id, style, emoji]) => button(id, label, style, emoji))
    ));
  }
  return componentsV2Payload(c);
}
async function buildTopGroupsPayload(guild, { viewerId = null, channelId = null } = {}) {
  const groups = await gm.listGroups(guild.id);
  const selectedGroup = selectMemberGroup(groups, viewerId, channelId);
  const sorted = [...groups].sort((a, b) => Number(b.points || 0) - Number(a.points || 0) || Number(a.id || 0) - Number(b.id || 0));
  const targetGroups = sorted.slice(0, 10);
  if (selectedGroup && !targetGroups.some(group => String(group.id) === String(selectedGroup.id))) targetGroups.push(selectedGroup);
  const memberRowsByGroup = {};
  if (selectedGroup) {
    memberRowsByGroup[String(selectedGroup.id)] = await gm.listMemberPoints(guild.id, selectedGroup.id, 1000).catch(() => []);
  }
  const groupAvatars = {};
  await Promise.all(targetGroups.map(async group => {
    try {
      const cached = guild.members?.cache?.get?.(String(group.owner_id));
      const owner = cached || await guild.members?.fetch?.(String(group.owner_id)).catch(() => null);
      groupAvatars[String(group.id)] = owner?.displayAvatarURL?.({ extension: 'png', size: 128 }) || null;
    } catch { groupAvatars[String(group.id)] = null; }
  }));
  const attachment = await renderTopGroups({ guild, groups, memberRowsByGroup, groupAvatars, selectedGroup, viewerId, accentColor: null });
  return { files: [attachment], components: topGroupsButtons(), allowedMentions: { parse: [] } };
}
function formatGroupDate(value) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return 'غير معروف';
  return new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function myGroupPayload(guild, group, userId, memberPoints, roleName) {
  const status = String(group.status || 'active').toLowerCase();
  const membership = String(group.owner_id) === String(userId) ? 'المالك'
    : group.managerIds.includes(String(userId)) ? 'مسؤول القروب' : 'عضو';
  const c = baseContainer(guild, 'قروبي', safe(group.name, 100));
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `### ${safe(group.name, 100)}\n**دورك:** ${membership}  •  **الحالة:** ${status === 'active' ? 'نشط' : status === 'orphaned' ? 'يحتاج تنظيفًا' : status}`
  ));
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `### تفاصيل القروب\n**المالك:** <@${group.owner_id}>\n**الرول:** ${safe(roleName || 'غير متاح', 100)}\n**الأعضاء:** ${Number(group.memberIds?.length || 0).toLocaleString('ar')}`
  ));
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `### النقاط والتواريخ\n**نقاط القروب:** ${Number(group.points || 0).toLocaleString('ar')}\n**نقاطك:** ${Number(memberPoints?.points || 0).toLocaleString('ar')}\n**تاريخ الإنشاء:** ${formatGroupDate(group.created_at)}`
  ));
  const groupActions = [];
  if (String(group.owner_id) === String(userId)) groupActions.push(button(`groups_top:transfer:${group.id}`, 'نقل الملكية', ButtonStyle.Primary));
  groupActions.push(button(`groups_top:leave:${group.id}`, 'مغادرة القروب', ButtonStyle.Danger, '<:emoji_21:1465336647477493894>'));
  c.addActionRowComponents(new ActionRowBuilder().addComponents(groupActions));
  return componentsV2Payload(c);
}
function leaveGroupPrompt(guild, group) {
  const c = baseContainer(guild, 'تأكيد المغادرة', `أنت على وشك مغادرة **${safe(group.name, 100)}**. ستُزال رتبة القروب وصلاحية الوصول إلى الثريد الخاص به.`);
  c.addActionRowComponents(new ActionRowBuilder().addComponents(
    button(`groups_top:leave-confirm:${group.id}`, 'تأكيد المغادرة', ButtonStyle.Danger),
    button(`groups_top:leave-cancel:${group.id}`, 'إلغاء', ButtonStyle.Secondary)
  ));
  return componentsV2Payload(c);
}
const topPanelLocks = new Map();
const TOP_BOARD_REFRESH_MS = 30_000;
const topPanelRefreshTimers = new Map();
function scheduleTopPanelRefresh(channel, guild, options = {}) {
  // One timer per guild: a new configured channel replaces the old timer instead of leaking intervals.
  const key = String(guild?.id || channel?.id || 'top-groups');
  const previous = topPanelRefreshTimers.get(key);
  if (previous) clearInterval(previous);
  const timer = setInterval(() => {
    if (!channel || channel.deleted || !channel.isTextBased?.()) {
      clearInterval(timer);
      if (topPanelRefreshTimers.get(key) === timer) topPanelRefreshTimers.delete(key);
      return;
    }
    sendTopGroupsPanel(channel, guild, options).catch(error => {
      console.error('[groups] automatic top-board refresh failed:', error?.message || error);
    });
  }, TOP_BOARD_REFRESH_MS);
  timer.unref?.();
  topPanelRefreshTimers.set(key, timer);
}
function isComponentsV2Message(message) {
  if (message?.flags?.has?.(MessageFlags.IsComponentsV2)) return true;
  const rawFlags = typeof message?.flags === 'number' ? message.flags : message?.flags?.bitfield;
  return (Number(rawFlags || 0) & MessageFlags.IsComponentsV2) !== 0;
}
async function sendTopGroupsPanel(channel, guild, options = {}) {
  const key = String(channel?.id || guild?.id || 'top-groups');
  if (topPanelLocks.has(key)) return topPanelLocks.get(key);
  const work = (async () => {
    const payload = await buildTopGroupsPayload(guild, { ...options, channelId: options.channelId || channel?.id });
    const messages = await channel?.messages?.fetch?.({ limit: 50 }).catch(() => null);
    const botId = guild?.client?.user?.id;
    const existing = messages && [...messages.values()]
      .filter(message => (!botId || message.author?.id === botId) && JSON.stringify(message.components || []).includes('groups_top:'))
      .sort((a, b) => Number(a.createdTimestamp || 0) - Number(b.createdTimestamp || 0)).pop();
    if (existing?.edit && !isComponentsV2Message(existing)) {
      const edited = await existing.edit(payload).catch(() => null);
      if (edited) {
        scheduleTopPanelRefresh(channel, guild, options);
        return edited;
      }
    }
    const sent = await channel.send(payload);
    if (existing?.delete) await existing.delete().catch(() => null);
    scheduleTopPanelRefresh(channel, guild, options);
    return sent;
  })();
  topPanelLocks.set(key, work);
  try { return await work; } finally { topPanelLocks.delete(key); }
}
async function handleTopGroupsInteraction(interaction, action, parts = []) {
  if (action === 'refresh') {
    await interaction.deferUpdate();
    if (isComponentsV2Message(interaction.message)) {
      return sendTopGroupsPanel(interaction.channel, interaction.guild, { channelId: interaction.channelId });
    }
    const payload = await buildTopGroupsPayload(interaction.guild, { channelId: interaction.channelId });
    if (interaction.message?.edit) return interaction.message.edit(payload);
    return null;
  }
  if (action === 'manage') {
    if (!await checkSystem(interaction)) return true;
    return reply(interaction, topManagePayload(interaction.guild));
  }
  if (action === 'transfer') {
    const group = await gm.getGroup(interaction.guild.id, Number(parts[0]));
    if (!group || String(group.owner_id) !== String(interaction.user.id)) return reply(interaction, { content: 'نقل الملكية متاح لمالك القروب الحالي فقط.' });
    const menu = new UserSelectMenuBuilder().setCustomId(`groups_top:transfer-select:${group.id}`).setPlaceholder('اختر عضوًا حاليًا لنقل الملكية').setMinValues(1).setMaxValues(1);
    const c = baseContainer(interaction.guild, 'نقل ملكية القروب', `اختر عضوًا من **${safe(group.name, 100)}**. ستنتقل رتبة المالك إليه، ويمكنك بعدها مغادرة القروب.`);
    c.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
    c.addActionRowComponents(new ActionRowBuilder().addComponents(button('groups_top:group', 'إلغاء', ButtonStyle.Secondary)));
    return reply(interaction, componentsV2Payload(c));
  }
  if (action === 'transfer-select') {
    try { return reply(interaction, { content: await transferGroupOwner(interaction, Number(parts[0]), interaction.values?.[0]) }); }
    catch (error) {
      const message = error.message === 'OWNER_MUST_BE_MEMBER' ? 'يجب اختيار عضو حالي في القروب.'
        : error.message === 'USER_ALREADY_IN_GROUP' ? 'العضو المختار مرتبط بقروب آخر.'
        : error.message === 'OWNER_ONLY' ? 'هذه العملية متاحة لمالك القروب فقط.' : 'تعذر نقل الملكية. تحقق من صلاحيات البوت والرتب.';
      return reply(interaction, { content: message });
    }
  }
  if (action === 'leave') {
    const group = await gm.getGroup(interaction.guild.id, Number(parts[0]));
    if (!group || group.status !== 'active' || !isGroupMember(group, interaction.user.id)) {
      return reply(interaction, { content: 'لم تعد عضوًا في هذا القروب.' });
    }
    if (String(group.owner_id) === String(interaction.user.id)) {
      return reply(interaction, { content: 'انقل ملكية القروب أولًا قبل المغادرة.' });
    }
    return interaction.update(leaveGroupPrompt(interaction.guild, group));
  }
  if (action === 'leave-cancel') {
    const c = baseContainer(interaction.guild, 'تم إلغاء المغادرة', 'لم يتم تغيير عضويتك.');
    c.addActionRowComponents(new ActionRowBuilder().addComponents(button('groups_top:group', 'العودة إلى قروبي', ButtonStyle.Secondary)));
    return interaction.update(componentsV2Payload(c));
  }
  if (action === 'leave-confirm') {
    await interaction.deferUpdate();
    const group = await gm.getGroup(interaction.guild.id, Number(parts[0]));
    if (!group || group.status !== 'active' || !isGroupMember(group, interaction.user.id)) {
      return reply(interaction, componentsV2Payload(baseContainer(interaction.guild, 'تعذرت المغادرة', 'لم تعد عضوًا في هذا القروب.')));
    }
    if (String(group.owner_id) === String(interaction.user.id)) {
      return reply(interaction, componentsV2Payload(baseContainer(interaction.guild, 'تعذرت المغادرة', 'انقل ملكية القروب أولًا قبل المغادرة.')));
    }
    try {
      const settings = await gm.getSettings(interaction.guild.id);
      await leaveGroupMember(interaction.guild, settings, group, interaction.user.id, interaction.user.id);
      activityCache.delete(String(interaction.guild.id));
      if (interaction.channel?.send) await sendTopGroupsPanel(interaction.channel, interaction.guild, { channelId: interaction.channelId }).catch(() => null);
      return reply(interaction, componentsV2Payload(baseContainer(interaction.guild, 'تمت المغادرة', `تمت مغادرة **${safe(group.name, 100)}** وإزالة صلاحيات القروب.`)));
    } catch (error) {
      console.error('[groups] member leave failed:', error?.message || error);
      const message = error.message === 'GROUP_ROLE_NOT_FOUND' ? 'رتبة القروب غير موجودة؛ لم يتم إكمال المغادرة.'
        : error.message === 'GROUP_THREAD_NOT_FOUND' ? 'ثريد القروب غير متاح؛ لم يتم إكمال المغادرة.'
          : 'تعذر إكمال المغادرة ومزامنة صلاحيات القروب.';
      return reply(interaction, componentsV2Payload(baseContainer(interaction.guild, 'تعذرت المغادرة', message)));
    }
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (action === 'rank') {
    const groups = await gm.listGroups(interaction.guild.id);
    const group = selectMemberGroup(groups, interaction.user?.id, interaction.channelId);
    if (!group) return interaction.editReply(responsePayload({ content: 'لا يوجد قروب مرتبط بعضويتك لعرض مركزه.', allowedMentions: { parse: [] } }));
    const full = await gm.getGroup(interaction.guild.id, group.id);
    const sorted = [...groups].sort((a, b) => Number(b.points || 0) - Number(a.points || 0) || Number(a.id || 0) - Number(b.id || 0));
    const memberRows = await gm.listMemberPoints(interaction.guild.id, full.id, 1000).catch(() => []);
    const owner = await interaction.guild.members.fetch(String(full.owner_id)).catch(() => null);
    const groupAvatar = owner?.displayAvatarURL?.({ extension: 'png', size: 256 }) || null;
    const ownerName = owner?.displayName || owner?.user?.globalName || owner?.user?.username || 'Unknown';
    const attachment = await renderMyRank({
      guild: interaction.guild,
      group: full,
      groupRank: Math.max(1, sorted.findIndex(item => String(item.id) === String(full.id)) + 1),
      totalGroups: sorted.length,
      memberRows,
      viewerId: interaction.user.id,
      groupAvatar,
      ownerName,
      accentColor: null
    });
    return interaction.editReply({ files: [attachment], allowedMentions: { parse: [] } });
  }
  if (action === 'group') {
    const groups = await gm.listGroups(interaction.guild.id);
    const group = selectMemberGroup(groups, interaction.user?.id, interaction.channelId);
    if (!group) return interaction.editReply(responsePayload({ content: 'لا يوجد قروب مرتبط بعضويتك.', allowedMentions: { parse: [] } }));
    const full = await gm.getGroup(interaction.guild.id, group.id);
    const role = full.role_id && (interaction.guild.roles.cache.get(String(full.role_id)) || await interaction.guild.roles.fetch(String(full.role_id)).catch(() => null));
    const memberPoints = await gm.getMemberPoints(interaction.guild.id, full.id, interaction.user.id).catch(() => null);
    return reply(interaction, myGroupPayload(interaction.guild, full, interaction.user.id, memberPoints, role?.name));
  }
  return interaction.editReply(responsePayload({ content: 'الزر غير معروف.' }));
}
const TOP_BONUS_ACTIONS = new Set(['group-add', 'group-remove', 'all-add', 'all-remove', 'member-add', 'member-remove']);
const usedTopBonusConfirmations = new Set();
function consumeTopBonusConfirmation(messageId) {
  const key = String(messageId || '');
  if (!key) return true;
  if (usedTopBonusConfirmations.has(key)) return false;
  usedTopBonusConfirmations.add(key);
  if (usedTopBonusConfirmations.size > 500) usedTopBonusConfirmations.delete(usedTopBonusConfirmations.values().next().value);
  return true;
}
function topBonusSelectionPayload(guild, action, groups, page = 0) {
  const pageSize = 25, pages = Math.max(1, Math.ceil(groups.length / pageSize));
  const currentPage = Math.max(0, Math.min(pages - 1, Number(page) || 0));
  const select = new StringSelectMenuBuilder()
    .setCustomId(`groups_bonus_select:${action}:${currentPage}`)
    .setPlaceholder('اختر القروب')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(groups.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(group => ({
      label: safe(group.name, 90),
      value: String(group.id),
      description: `${Number(group.points || 0).toLocaleString()} نقطة • ${group.memberIds?.length || 0} أعضاء`.slice(0, 100)
    })));
  const description = action.startsWith('group-')
    ? 'مسؤولو نظام القروبات فقط: سيُعدّل إجمالي نقاط القروب دون تغيير أرصدة الأعضاء. اختر القروب المطلوب.'
    : 'مسؤولو نظام القروبات فقط: سيُعدّل رصيد عضو محدد مع تحديث إجمالي القروب. اختر القروب المطلوب.';
  const c = baseContainer(guild, 'اختيار القروب', description);
  c.addActionRowComponents(new ActionRowBuilder().addComponents(select));
  if (pages > 1) {
    c.addActionRowComponents(new ActionRowBuilder().addComponents(
      button(`groups_bonus_page:${action}:${currentPage - 1}`, 'السابق', ButtonStyle.Secondary).setDisabled(currentPage === 0),
      button(`groups_bonus_page:${action}:${currentPage + 1}`, 'التالي', ButtonStyle.Secondary).setDisabled(currentPage >= pages - 1)
    ));
  }
  return componentsV2Payload(c);
}
async function openTopBonusGroupPicker(interaction, action, page = 0, update = false) {
  const settings = await checkSystem(interaction);
  if (!settings) return true;
  if (!TOP_BONUS_ACTIONS.has(action) || action.startsWith('all-')) return reply(interaction, { content: 'إجراء النقاط غير معروف.' });
  const groups = await gm.listGroups(interaction.guild.id);
  if (!groups.length) return reply(interaction, { content: 'لا توجد قروبات نشطة لتعديل نقاطها.' });
  const payload = topBonusSelectionPayload(interaction.guild, action, groups, page);
  if (update && interaction.update) return interaction.update(payload);
  return reply(interaction, payload, true);
}
function topBonusAmountModal(action, groupId, userId = null) {
  const modal = new ModalBuilder()
    .setCustomId(`groups_bonus_modal:${action}:${groupId}${userId ? `:${userId}` : ''}`)
    .setTitle(action.endsWith('add') ? 'إضافة نقاط' : 'خصم نقاط');
  const amountLabel = action.startsWith('all-') ? 'النقاط لكل قروب' : 'عدد النقاط';
  const placeholder = action.startsWith('all-') ? 'مثال 100 نقطة لكل قروب' : 'مثال 100';
  modal.addLabelComponents(new LabelBuilder().setLabel(amountLabel).setTextInputComponent(
    new TextInputBuilder().setCustomId('amount').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12).setPlaceholder(placeholder)
  ));
  return modal;
}
async function refreshTopBoardAfterBonus(interaction, settings) {
  const channelId = settings.topChannelId || interaction.channelId;
  if (!channelId) return false;
  let channel = interaction.guild.channels.cache.get(String(channelId));
  if (!channel) channel = await interaction.guild.channels.fetch(String(channelId)).catch(() => null);
  if (!channel?.send) return false;
  await sendTopGroupsPanel(channel, interaction.guild, { channelId: channel.id });
  return true;
}
function pointsAdjustmentError(error) {
  return ({
    GROUP_NOT_FOUND: 'القروب غير موجود أو لم يعد نشطًا.',
    MEMBER_NOT_IN_GROUP: 'العضو لم يعد عضوًا في القروب.',
    INSUFFICIENT_GROUP_POINTS: 'النقاط المطلوب خصمها أكبر من رصيد القروب.',
    INSUFFICIENT_MEMBER_POINTS: 'النقاط المطلوب خصمها أكبر من رصيد العضو.',
    NO_POINTS_TO_REMOVE: 'لا توجد نقاط متاحة للخصم.',
    INVALID_POINTS_ADJUSTMENT: 'أدخل عددًا صحيحًا موجبًا لا يتجاوز مليون نقطة.',
    POINTS_LIMIT_EXCEEDED: 'تجاوزت النقاط الحد المسموح.'
  })[error?.message] || 'تعذر تعديل نقاط القروب.';
}
async function openTopBonusConfirmation(interaction, action, group, amount, userId = null, current = 0) {
  const subject = action.startsWith('group-') ? `إجمالي القروب **${safe(group.name)}**` : `رصيد العضو <@${userId}> في **${safe(group.name)}**`;
  const after = current - amount;
  const c = baseContainer(interaction.guild, 'تأكيد خصم النقاط', `تأكيد خصم **${amount.toLocaleString()}** نقطة من ${subject}.\nالرصيد الحالي ${current.toLocaleString()} وبعد الخصم ${after.toLocaleString()}.`);
  c.addActionRowComponents(new ActionRowBuilder().addComponents(
    button(`groups_bonus_confirm:${action}:${group.id}:${amount}${userId ? `:${userId}` : ''}`, 'تأكيد', ButtonStyle.Danger, '<:emoji_21:1465336647477493894>'),
    button('groups_bonus:cancel', 'إلغاء', ButtonStyle.Secondary)
  ));
  return reply(interaction, componentsV2Payload(c), true);
}
async function handleTopBonusButton(interaction, action) {
  if (action === 'cancel') {
    if (!consumeTopBonusConfirmation(interaction.message?.id)) return reply(interaction, { content: 'تم استخدام تأكيد الخصم أو إلغاؤه مسبقًا.' });
    return interaction.update(responsePayload({ content: 'تم الإلغاء.', components: [], allowedMentions: { parse: [] } }));
  }
  if (action === 'all-add' || action === 'all-remove') {
    if (!await checkSystem(interaction)) return true;
    if (!(await gm.listGroups(interaction.guild.id)).length) return reply(interaction, { content: 'لا توجد قروبات نشطة لتعديل نقاطها.' });
    return interaction.showModal(topBonusAmountModal(action, 'all'));
  }
  return openTopBonusGroupPicker(interaction, action, 0, false);
}
async function handleTopBonusPage(interaction, action, parts) {
  return openTopBonusGroupPicker(interaction, action, Number(parts[0]) || 0, true);
}
async function handleTopBonusSelection(interaction, action, parts) {
  const settings = await checkSystem(interaction);
  if (!settings) return true;
  if (!TOP_BONUS_ACTIONS.has(action) || action.startsWith('all-')) return reply(interaction, { content: 'إجراء النقاط غير معروف.' });
  const groupId = Number(interaction.values?.[0]);
  const group = await gm.getGroup(interaction.guild.id, groupId);
  if (!group || group.status !== 'active') return reply(interaction, { content: 'القروب غير موجود أو لم يعد نشطًا.' });
  if (action.startsWith('group-')) return interaction.showModal(topBonusAmountModal(action, groupId));
  const c = baseContainer(interaction.guild, 'اختيار العضو', `اختر عضوًا حاليًا من قروب **${safe(group.name)}**.`);
  const users = new UserSelectMenuBuilder().setCustomId(`groups_bonus_member_select:${action}:${groupId}`).setPlaceholder('اختر عضوًا').setMinValues(1).setMaxValues(1);
  c.addActionRowComponents(new ActionRowBuilder().addComponents(users));
  return interaction.update(componentsV2Payload(c));
}
async function handleTopBonusMemberSelection(interaction, action, parts) {
  const settings = await checkSystem(interaction);
  if (!settings) return true;
  if (!TOP_BONUS_ACTIONS.has(action) || !action.startsWith('member-')) return reply(interaction, { content: 'إجراء نقاط العضو غير معروف.' });
  const groupId = Number(parts[0]), userId = String(interaction.values?.[0] || '');
  const group = await gm.getGroup(interaction.guild.id, groupId);
  if (!group || group.status !== 'active') return reply(interaction, { content: 'القروب غير موجود أو لم يعد نشطًا.' });
  if (!isGroupMember(group, userId)) return reply(interaction, { content: 'العضو غير تابع لهذا القروب.' });
  return interaction.showModal(topBonusAmountModal(action, groupId, userId));
}
function parseBonusAmount(value) {
  const normalized = String(value || '').trim()
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[،,\s]/g, '');
  const amount = Number(normalized);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000) throw new Error('INVALID_POINTS_ADJUSTMENT');
  return amount;
}
async function performTopBonusAdjustment(interaction, settings, action, groupId, amount, userId = null) {
  const delta = action.endsWith('add') ? amount : -amount;
  const result = action.startsWith('all-')
    ? await gm.adjustAllGroupPoints(interaction.guild.id, delta, interaction.user.id)
    : action.startsWith('group-')
      ? await gm.adjustGroupPoints(interaction.guild.id, groupId, delta, interaction.user.id)
      : await gm.adjustMemberPoints(interaction.guild.id, groupId, userId, delta, interaction.user.id);
  const updated = await refreshTopBoardAfterBonus(interaction, settings).catch(() => false);
  const operation = action.endsWith('add') ? 'إضافة' : 'خصم';
  const summary = action.startsWith('all-')
    ? `لكل قروب نشط (${result.changedGroups} من ${result.groups} قروبًا؛ الإجمالي ${result.before.toLocaleString()} ← ${result.after.toLocaleString()})`
    : action.startsWith('group-') ? 'من إجمالي نقاط القروب' : `من رصيد نقاط العضو <@${userId}>`;
  return { result, updated, content: `تم ${operation} **${amount.toLocaleString()}** نقطة ${summary}.${updated ? '' : '\nتعذر تحديث لوحة التوب تلقائيًا.'}` };
}
async function handleTopBonusModal(interaction, action, parts) {
  const settings = await checkSystem(interaction);
  if (!settings) return true;
  if (!TOP_BONUS_ACTIONS.has(action)) return reply(interaction, { content: 'إجراء النقاط غير معروف.' });
  if (action.startsWith('all-')) {
    if (parts[0] !== 'all') return reply(interaction, { content: 'بيانات تعديل النقاط غير صالحة.' });
    let amount;
    try { amount = parseBonusAmount(interaction.fields.getTextInputValue('amount')); }
    catch (error) { return reply(interaction, { content: pointsAdjustmentError(error) }); }
    if (action === 'all-remove') {
      const groups = await gm.listGroups(interaction.guild.id);
      if (!groups.length) return reply(interaction, { content: 'لا توجد قروبات نشطة لتعديل نقاطها.' });
      const before = groups.reduce((total, group) => total + Math.max(0, Number(group.points) || 0), 0);
      const after = groups.reduce((total, group) => total + Math.max(0, Number(group.points || 0) - amount), 0);
      if (before === after) return reply(interaction, { content: pointsAdjustmentError(new Error('NO_POINTS_TO_REMOVE')) });
      const c = baseContainer(interaction.guild, 'تأكيد خصم نقاط القروبات', `تأكيد خصم حتى **${amount.toLocaleString()}** نقطة من كل قروب نشط.\nإجمالي النقاط الحالي ${before.toLocaleString()} وبعد الخصم ${after.toLocaleString()}.`);
      c.addActionRowComponents(new ActionRowBuilder().addComponents(
        button(`groups_bonus_confirm:all-remove:${amount}`, 'تأكيد', ButtonStyle.Danger, '<:emoji_21:1465336647477493894>'),
        button('groups_bonus:cancel', 'إلغاء', ButtonStyle.Secondary)
      ));
      return reply(interaction, componentsV2Payload(c), true);
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { content } = await performTopBonusAdjustment(interaction, settings, action, null, amount);
      return reply(interaction, { content });
    } catch (error) { return reply(interaction, { content: pointsAdjustmentError(error) }); }
  }
  const groupId = Number(parts[0]), userId = parts[1] ? String(parts[1]) : null;
  const group = await gm.getGroup(interaction.guild.id, groupId);
  if (!group || group.status !== 'active') return reply(interaction, { content: 'القروب غير موجود أو لم يعد نشطًا.' });
  if (action.startsWith('member-') && (!userId || !isGroupMember(group, userId))) return reply(interaction, { content: 'العضو لم يعد عضوًا في القروب.' });
  let amount;
  try { amount = parseBonusAmount(interaction.fields.getTextInputValue('amount')); }
  catch (error) { return reply(interaction, { content: pointsAdjustmentError(error) }); }
  if (action.endsWith('remove')) {
    const current = action.startsWith('group-') ? Number(group.points || 0)
      : Number((await gm.getMemberPoints(interaction.guild.id, groupId, userId))?.points || 0);
    if (amount > current) return reply(interaction, { content: pointsAdjustmentError(new Error(action.startsWith('group-') ? 'INSUFFICIENT_GROUP_POINTS' : 'INSUFFICIENT_MEMBER_POINTS')) });
    return openTopBonusConfirmation(interaction, action, group, amount, userId, current);
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const { content } = await performTopBonusAdjustment(interaction, settings, action, groupId, amount, userId);
    return reply(interaction, { content });
  } catch (error) { return reply(interaction, { content: pointsAdjustmentError(error) }); }
}
async function handleTopBonusConfirm(interaction, action, parts) {
  const confirmationKey = String(interaction.message?.id || '');
  if (!consumeTopBonusConfirmation(confirmationKey)) return reply(interaction, { content: 'تم استخدام تأكيد الخصم أو إلغاؤه مسبقًا.' });
  const settings = await checkSystem(interaction);
  if (!settings) return true;
  if (!TOP_BONUS_ACTIONS.has(action) || !action.endsWith('remove')) return reply(interaction, { content: 'تأكيد النقاط غير صالح.' });
  const isAllGroups = action === 'all-remove';
  const [rawGroupId, rawAmount, rawUserId] = parts;
  const groupId = isAllGroups ? null : Number(rawGroupId);
  const amount = Number(isAllGroups ? rawGroupId : rawAmount);
  const userId = isAllGroups ? null : (rawUserId ? String(rawUserId) : null);
  if ((!isAllGroups && (!Number.isSafeInteger(groupId) || groupId <= 0)) || !Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000) return reply(interaction, { content: 'بيانات الخصم غير صالحة.' });
  await interaction.update(responsePayload({ content: 'جارٍ تنفيذ الخصم...', components: [], allowedMentions: { parse: [] } }));
  try {
    const { content } = await performTopBonusAdjustment(interaction, settings, action, groupId, amount, userId);
    return interaction.followUp(responsePayload({ content, ephemeral: true, allowedMentions: { parse: [] } }));
  } catch (error) {
    return interaction.followUp(responsePayload({ content: pointsAdjustmentError(error), ephemeral: true, allowedMentions: { parse: [] } }));
  }
}
async function sendGroupPanel(channel, guild, groupId) {
  const payload = { ...controlGroupPayload(guild, groupId), allowedMentions: { parse: [] } };
  const id = Number(groupId);
  const messages = await channel?.messages?.fetch?.({ limit: 100 }).catch(() => null);
  const botId = guild?.client?.user?.id;
  const marker = `:${id}:`;
  const existing = messages && [...messages.values()].filter(message =>
    (!botId || message.author?.id === botId)
    && JSON.stringify(message.components || []).includes('groups_control:')
    && JSON.stringify(message.components || []).includes(marker)
  ).sort((a, b) => Number(a.createdTimestamp || 0) - Number(b.createdTimestamp || 0)).pop();
  if (existing?.edit) {
    const edited = await existing.edit(payload).catch(() => null);
    if (edited) return edited;
  }
  try {
    return await channel.send(payload);
  } catch (error) {
    console.error(`تعذر إرسال Container لوحة القروب ${groupId}:`, error?.stack || error?.message || error);
    const controls = [
      ['lock', 'text', 'قفل النص'], ['unlock', 'text', 'فتح النص'], ['hide', 'text', 'إخفاء النص'], ['show', 'text', 'إظهار النص'], ['mute', 'text', 'كتم النص'],
      ['unmute', 'text', 'فك كتم النص'], ['lock', 'voice', 'قفل الفويس'], ['unlock', 'voice', 'فتح الفويس'], ['hide', 'voice', 'إخفاء الفويس'], ['show', 'voice', 'إظهار الفويس'],
      ['mute', 'voice', 'كتم الفويس'], ['unmute', 'voice', 'فك كتم الفويس'], ['kick', 'voice', 'فصل من الفويس'], ['allow', 'both', 'سماح'], ['deny', 'both', 'منع'],
      ['rename', 'both', 'تغيير الاسم'], ['limit', 'voice', 'حد الفويس'], ['permission', 'both', 'الصلاحيات']
    ];
    const rows = [];
    for (let offset = 0; offset < controls.length; offset += 5) {
      rows.push(new ActionRowBuilder().addComponents(controls.slice(offset, offset + 5).map(([action, scope, label]) => button(`groups_control:${action}:${id}:${scope}`, label, action === 'deny' || action === 'kick' ? ButtonStyle.Danger : ButtonStyle.Secondary))));
    }
    rows.push(new ActionRowBuilder().addComponents(button(`groups_member:info:${id}`, 'قروبي')));
    try {
      const fallback = new ContainerBuilder().setAccentColor(colorToNumber(colorManager.getColor?.() || '#5865F2'));
      fallback.addTextDisplayComponents(new TextDisplayBuilder().setContent('## التحكم بالقروب\nاستخدم الأزرار لإدارة القروب.'));
      fallback.addActionRowComponents(...rows);
      return await channel.send({ components: [fallback], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
    } catch (fallbackError) {
      console.error(`تعذر إرسال لوحة القروب الاحتياطية ${groupId}:`, fallbackError?.stack || fallbackError?.message || fallbackError);
      return null;
    }
  }
}
async function sendMemberControlPanels(channel, guild) {
  const groups = await gm.listGroups(guild.id);
  let published = 0;
  for (let offset = 0; offset < groups.length; offset += 5) {
    const batch = groups.slice(offset, offset + 5);
    const results = await Promise.all(batch.map(group => sendGroupPanel(channel, guild, group.id).catch(() => null)));
    published += results.filter(Boolean).length;
  }
  const overview = await sendMemberOverviewPanel(channel, guild, groups.length).catch(() => null);
  return { total: groups.length, published, failed: groups.length - published, overview: Boolean(overview) };
}
function memberOverviewPayload(guild, groupCount) {
  const description = groupCount
    ? `تم العثور على ${groupCount} قروب نشط. لوحات التحكم الخاصة بكل قروب موجودة في هذه القناة.`
    : 'لا توجد قروبات نشطة الآن. ستظهر لوحة كل قروب هنا عند إنشائه.';
  const c = baseContainer(guild, 'لوحة تحكم الأعضاء', description);
  const notice = button('groups_member:overview', 'لوحات القروبات تظهر هنا', ButtonStyle.Secondary).setDisabled(true);
  c.addActionRowComponents(new ActionRowBuilder().addComponents(notice));
  return componentsV2Payload(c);
}
async function sendMemberOverviewPanel(channel, guild, groupCount) {
  const payload = memberOverviewPayload(guild, groupCount);
  const messages = await channel?.messages?.fetch?.({ limit: 100 }).catch(() => null);
  const botId = guild?.client?.user?.id;
  const existing = messages && [...messages.values()].filter(message =>
    (!botId || message.author?.id === botId) && JSON.stringify(message.components || []).includes('groups_member:overview')
  ).sort((a, b) => Number(a.createdTimestamp || 0) - Number(b.createdTimestamp || 0)).pop();
  if (existing?.edit) {
    const edited = await existing.edit(payload).catch(() => null);
    if (edited) return edited;
  }
  return channel.send(payload);
}
function groupCommandGuideText(group, settings) {
  const lines = [
    `## أوامر القروب ${safe(group?.name || 'قروب', 80)}`,
    'اكتب الأمر في بداية الرسالة داخل روم القروب بدون أي بادئة.',
    '',
    '**للمالك والمسؤولين**',
    '• `تحكم` لفتح لوحة التحكم.',
    '• `تعديل القروب` لمعرفة طريقة تعديل القروب من اللوحة.',
    '• `إضافة @عضو` لإضافة عضو إلى القروب.',
    '• `إزالة @عضو` لإزالة عضو من القروب.',
    '• `منع @عضو` و`سماح @عضو` لإدارة المنع.',
    '• `صلاحية` لعرض طريقة التحكم بوصول الأعضاء عبر رتبة القروب.',
    '',
    '**لجميع أعضاء القروب**',
    '• `قروبي` لعرض معلومات القروب.',
    '• `أعضاء` لعرض صورة ترتيب الأعضاء ونقاطهم.',
    '',
    '**للمالك أو مسؤول النظام فقط**',
    '• `مسؤول @عضو` لإضافة مسؤول للقروب بعد إضافته كعضو.',
    '• `مسؤول إزالة @عضو` لإزالة مسؤول من القروب.'
  ];
  if (settings?.extraPermissions) {
    lines.push('', '**عند تفعيل الصلاحيات الإضافية**', '• `مسح` لمسح الرسائل الحديثة.', '• `عقوبة @عضو` لتطبيق عقوبة 10 دقائق على عضو غير محمي.');
  }
  return lines.join('\n');
}
async function sendGroupCommandGuide(channel, group, settings) {
  if (!channel?.send) return null;
  return channel.send({ content: groupCommandGuideText(group, settings), allowedMentions: { parse: [] } });
}
function createGroupModal(defaultOwnerId = '') {
  const modal = new ModalBuilder().setCustomId('groups_modal:create').setTitle('إنشاء قروب');
  modal.addLabelComponents(new LabelBuilder().setLabel('اسم القروب').setTextInputComponent(
    new TextInputBuilder().setCustomId('group_name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)
  ));
  modal.addLabelComponents(new LabelBuilder().setLabel('معرف المالك أو منشنه').setTextInputComponent(
    new TextInputBuilder().setCustomId('group_owner').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder(String(defaultOwnerId || ''))
  ));
  return modal;
}
async function createFromModal(interaction) {
  const settings = await checkSystem(interaction);
  if (!settings) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const groupName = safe(interaction.fields.getTextInputValue('group_name'), 80).trim();
  const ownerValue = interaction.fields.getTextInputValue('group_owner') || '';
  const ownerId = ownerValue.match(/\d{16,20}/)?.[0] || interaction.user.id;
  if (!groupName) return reply(interaction, { content: 'اسم القروب مطلوب.' });

  let group;
  try {
    group = await gm.createGroup(interaction.guild, { name: groupName, ownerId, color: '#5865F2' }, interaction.user.id);
  } catch (error) {
    const message = error.message?.startsWith('GROUP_SETUP_REQUIRED')
      ? 'أكمل إعدادات القروبات أولًا.'
      : `تعذر إنشاء القروب ${error.message ? `— ${safe(error.message, 400)}` : ''}`;
    return reply(interaction, { content: message });
  }

  await gm.logGroupEvent(interaction.guild, 'create', { groupId: group.id, name: group.name, ownerId: group.owner_id }, interaction.user.id).catch(() => null);
  let musicResult = { ok: false, code: 'MUSIC_CHANNEL_NOT_CONFIGURED' };
  if (settings.musicChannelId) {
    const voiceChannel = await channelById(interaction.guild, group.voice_channel_id);
    if (!voiceChannel) musicResult = { ok: false, code: 'MOVE_FAILED' };
    else if (typeof tempVoice.ensureMusicBotInVoiceRoom !== 'function') musicResult = { ok: false, code: 'MOVE_FAILED' };
    else {
      try {
        musicResult = await tempVoice.ensureMusicBotInVoiceRoom(interaction.guild, voiceChannel, {
          musicChannelId: settings.musicChannelId,
          reason: 'Move music bot to newly created group'
        });
      } catch (error) {
        console.error('[groups] failed to move music bot after group creation:', error?.message || error);
        musicResult = { ok: false, code: 'MOVE_FAILED' };
      }
    }
  }
  await gm.logGroupEvent(interaction.guild, 'music', { groupId: group.id, ok: Boolean(musicResult?.ok), code: musicResult?.code || null }, interaction.user.id).catch(() => null);

  const defaultChannel = await channelById(interaction.guild, group.thread_id || group.text_channel_id);
  const configuredChannel = settings.memberControlChannelId ? await channelById(interaction.guild, settings.memberControlChannelId) : null;
  if (group.thread_id && defaultChannel?.members?.add) await defaultChannel.members.add(ownerId).catch(() => null);
  const panelChannel = configuredChannel || defaultChannel;
  let panelPublished = false;
  if (panelChannel) {
    try { panelPublished = Boolean(await sendGroupPanel(panelChannel, interaction.guild, group.id)); }
    catch (error) { console.error('[groups] failed to publish group control panel:', error?.message || error); }
  }
  if (configuredChannel) {
    const groups = await gm.listGroups(interaction.guild.id).catch(() => []);
    await sendMemberOverviewPanel(configuredChannel, interaction.guild, groups.length).catch(() => null);
  }
  const guideChannel = defaultChannel || panelChannel;
  await sendGroupCommandGuide(guideChannel, group, settings).catch(error => {
    console.error('[groups] failed to publish group command guide:', error?.message || error);
    return null;
  });

  const panelNote = panelChannel && !panelPublished ? '\nتعذر نشر لوحة التحكم تلقائيًا؛ تحقق من صلاحيات البوت في القناة.' : '';
  return reply(interaction, {
    content: `تم إنشاء القروب **${safe(group.name)}**\nحالة الموسيقى — ${musicResultMessage(musicResult)}${panelNote}`
  });
}
const CLEARABLE_SETUP_FIELDS = [
  ['chatMode', 'نمط الشات', value => value === 'threads' ? 'ثريدات' : 'رومات مستقلة'],
  ['textCategoryId', 'كاتاقوري النص/الثريدات', value => `<#${value}>`],
  ['voiceCategoryId', 'كاتاقوري الصوت', value => `<#${value}>`],
  ['topChannelId', 'روم الترتيب', value => `<#${value}>`],
  ['adminControlChannelId', 'روم تحكم الإدارة', value => `<#${value}>`],
  ['memberControlChannelId', 'روم تحكم الأعضاء', value => `<#${value}>`],
  ['mainRoleId', 'الرول الرئيسي', value => `<@&${value}>`],
  ['leaderRoleId', 'رول المالك', value => `<@&${value}>`],
  ['managerRoleId', 'رول المسؤول', value => `<@&${value}>`],
  ['musicChannelId', 'روم مصدر الموسيقى', value => `<#${value}>`],
  ['logChannelId', 'روم السجلات', value => `<#${value}>`]
];
function managerSetupPayload(guild, settings) {
  const entries = [
    ...settings.systemUsers.map(id => `<@${id}>`),
    ...settings.systemRoles.map(id => `<@&${id}>`)
  ];
  const visible = entries.slice(0, 20);
  const current = visible.length ? visible.join('، ') + (entries.length > visible.length ? `، و${entries.length - visible.length} آخرين` : '') : 'لا يوجد مسؤولو نظام مضافون.';
  const c = baseContainer(guild, 'مسؤولو النظام', `المسؤولون الحاليون (${entries.length}):\n${current}\nيمكنك إضافة حتى 5 أعضاء أو رتب في كل مرة، أو إزالة عدة معرفات دفعة واحدة.`);
  c.addActionRowComponents(new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('groups_setup_manager:add:user').setPlaceholder('إضافة أعضاء').setMinValues(1).setMaxValues(5)));
  c.addActionRowComponents(new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('groups_setup_manager:add:role').setPlaceholder('إضافة رتب').setMinValues(1).setMaxValues(5)));
  c.addActionRowComponents(new ActionRowBuilder().addComponents(button('groups_setup_manager:remove', 'إزالة مسؤولي نظام', ButtonStyle.Danger)));
  return componentsV2Payload(c);
}
function setupManagerRemovalModal() {
  const modal = new ModalBuilder().setCustomId('groups_setup_manager:remove').setTitle('إزالة مسؤولي النظام');
  modal.addLabelComponents(new LabelBuilder().setLabel('منشن أو معرفات الأعضاء والرتب').setTextInputComponent(new TextInputBuilder().setCustomId('ids').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000).setPlaceholder('مثال: @عضو 123456789012345678')));
  return modal;
}
async function handleSetup(interaction, action) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const settings = await checkSystem(interaction);
  if (!settings) return true;
  if (action === 'toggle') {
    if (!settings.enabled) {
      await hydrateSetupReferences(interaction.guild, settings);
      const missing = gm.validateConfig(interaction.guild, settings);
      if (missing.length) return reply(interaction, { content: `لا يمكن تفعيل نظام القروبات قبل إصلاح الإعدادات التالية:\n${missing.map(setupIssueLabel).join('\n')}` });
    }
    const updated = await gm.saveSettings(interaction.guild.id, { enabled: !settings.enabled }, interaction.user.id);
    await refreshSetupPanel(interaction, updated);
    return reply(interaction, setupConfirmation(interaction, 'حالة نظام القروبات', `تم ${!settings.enabled ? 'تفعيل' : 'إيقاف'} نظام القروبات.`));
  }
  if (action === 'audit') {
    await hydrateSetupReferences(interaction.guild, settings);
    const missing = gm.validateConfig(interaction.guild, settings);
    const content = missing.length
      ? `نتيجة التدقيق: يوجد ${missing.length} نقصًا يمنع إنشاء القروبات أو قد يعطلها:\n${missing.map(setupIssueLabel).join('\n')}`
      : `نتيجة التدقيق: الإعدادات الأساسية مكتملة. النظام ${settings.enabled ? 'مفعل' : 'جاهز لكنه متوقف'}.`;
    return reply(interaction, { content });
  }
  if (action === 'clear') {
    const options = CLEARABLE_SETUP_FIELDS.filter(([key]) => settings[key] != null && settings[key] !== '').map(([key, label, format]) => ({ label: safe(label, 100), value: key, description: safe(`الحالي: ${format(settings[key])}`, 100) }));
    if (!options.length) return reply(interaction, { content: 'لا توجد قيم محفوظة لمسحها.' });
    return reply(interaction, selectPayload(interaction.guild, 'مسح إعداد', 'اختر قيمة واحدة لمسحها. مسح إعداد مطلوب يمنع إنشاء القروبات حتى تعيد ضبطه.', 'groups_setup_clear_select', options));
  }
  if (action === 'chatmode') return reply(interaction, selectPayload(interaction.guild, 'نمط الشات', 'اختر طريقة إنشاء مساحات شات القروبات.', 'groups_setup_select:chatmode', [
    { label: 'ثريدات', value: 'threads', description: 'روم أب واحد مع ثريدات خاصة' },
    { label: 'رومات', value: 'channels', description: 'روم نصي مستقل لكل قروب' }
  ]));
  if (action === 'extra') {
    if (!settings.extraPermissions) {
      await hydrateSetupReferences(interaction.guild, settings);
      const extraPermissions = ['ManageMessages', 'ModerateMembers', 'MoveMembers'];
      const missing = gm.validateConfig(interaction.guild, { ...settings, extraPermissions: true })
        .filter(issue => issue.startsWith('permission:') && extraPermissions.includes(issue.slice('permission:'.length)));
      if (missing.length) return reply(interaction, { content: `لا يمكن تفعيل الأدوات الإضافية قبل منح البوت:\n${missing.map(setupIssueLabel).join('\n')}` });
    }
    const updated = await gm.saveSettings(interaction.guild.id, { extraPermissions: !settings.extraPermissions }, interaction.user.id);
    await refreshSetupPanel(interaction, updated);
    return reply(interaction, setupConfirmation(interaction, 'الصلاحيات الإضافية', `تم ${!settings.extraPermissions ? 'تفعيل' : 'تعطيل'} الصلاحيات الإضافية.`));
  }
  if (action === 'scope') return reply(interaction, selectPayload(interaction.guild, 'نطاق النقاط', 'اختر أين يتم احتساب تفاعل القروبات.', 'groups_setup_select:scope', [
    { label: 'رومات القروبات فقط', value: 'group', description: 'رومات نص وفويس القروبات فقط' },
    { label: 'كل الرومات', value: 'all', description: 'كل رومات السيرفر المقروءة' }
  ]));
  if (['log', 'topchannel', 'adminchannel', 'memberchannel'].includes(action)) {
    const menu = new ChannelSelectMenuBuilder().setCustomId(`groups_setup_channel:${action}`).setPlaceholder('اختر رومًا نصيًا').setMinValues(1).setMaxValues(1).setChannelTypes(ChannelType.GuildText);
    const c = baseContainer(interaction.guild, 'إعدادات القنوات', 'اختر رومًا نصيًا واحدًا.');
    c.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
    return reply(interaction, componentsV2Payload(c));
  }
  if (['mainrole', 'leaderrole', 'managerrole'].includes(action)) {
    const menu = new RoleSelectMenuBuilder().setCustomId(`groups_setup_role:${action}`).setPlaceholder('اختر رولًا').setMinValues(1).setMaxValues(1);
    const c = baseContainer(interaction.guild, 'إعداد الرول', 'اختر رولًا واحدًا.');
    c.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
    return reply(interaction, componentsV2Payload(c));
  }
  if (['textcat', 'voicecat', 'music'].includes(action)) {
    const type = action === 'textcat' || action === 'voicecat' ? ChannelType.GuildCategory : ChannelType.GuildVoice;
    const menu = new ChannelSelectMenuBuilder().setCustomId(`groups_setup_channel:${action}`).setPlaceholder('اختر رومًا').setMinValues(1).setMaxValues(1).setChannelTypes(type);
    const c = baseContainer(interaction.guild, 'إعداد الروم', 'اختر رومًا واحدًا.');
    c.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
    return reply(interaction, componentsV2Payload(c));
  }
  if (action === 'rules') return reply(interaction, rulesPayload(interaction.guild, await gm.getRules(interaction.guild.id)));
  if (action === 'managers') return reply(interaction, managerSetupPayload(interaction.guild, settings));
  return reply(interaction, setupConfirmation(interaction, 'إعدادات القروبات', 'تم تنفيذ إعداد القروبات.'));
}
async function handleSetupManager(interaction, action, parts = []) {
  if (action === 'remove' && interaction.isButton?.()) {
    const settings = await checkSystem(interaction);
    if (!settings) return true;
    return interaction.showModal(setupManagerRemovalModal());
  }
  if (!interaction.deferred && !interaction.replied) {
    if (interaction.isModalSubmit?.()) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    else await interaction.deferUpdate();
  }
  const settings = await checkSystem(interaction);
  if (!settings) return true;
  if (String(interaction.guild.ownerId) !== String(interaction.user.id) && !gm.isOwner(interaction.client, interaction.member)) {
    return reply(interaction, { content: 'إضافة مسؤولي النظام وإزالتهم متاحة لمالك السيرفر أو مالك البوت فقط.' });
  }
  if (action === 'remove') {
    let removeIds = [];
    if (interaction.isModalSubmit?.()) {
      removeIds = [...new Set((interaction.fields.getTextInputValue('ids').match(/\d{16,20}/g) || []).map(String))];
    } else {
      removeIds = (interaction.values || []).flatMap(value => String(value).split(':').slice(-1)).filter(id => /^\d{16,20}$/.test(id));
    }
    if (!removeIds.length) return reply(interaction, { content: 'لم أجد معرفات صحيحة لإزالتها.' });
    const remove = new Set(removeIds);
    const systemUsers = settings.systemUsers.filter(id => !remove.has(String(id)));
    const systemRoles = settings.systemRoles.filter(id => !remove.has(String(id)));
    const removed = settings.systemUsers.length - systemUsers.length + settings.systemRoles.length - systemRoles.length;
    const updated = await gm.saveSettings(interaction.guild.id, { systemUsers, systemRoles }, interaction.user.id);
    await refreshSetupPanel(interaction, updated);
    return reply(interaction, setupConfirmation(interaction, 'مسؤولو النظام', removed ? `تمت إزالة ${removed} مسؤول.` : 'لم تتطابق المعرفات مع مسؤولين محفوظين.'));
  }
  const ids = interaction.values || [];
  if (!ids.length) return reply(interaction, { content: 'اختر عضوًا أو رتبة أولًا.' });
  if (action === 'add' && parts[0] === 'user') {
    const members = await Promise.all(ids.map(id => interaction.guild.members.fetch(String(id)).catch(() => null)));
    if (members.some(member => !member || member.user?.bot)) return reply(interaction, { content: 'لا يمكن إضافة بوت أو عضو غير موجود كمسؤول نظام.' });
    const updated = await gm.saveSettings(interaction.guild.id, { systemUsers: [...new Set([...settings.systemUsers, ...ids.map(String)])] }, interaction.user.id);
    await refreshSetupPanel(interaction, updated);
    return reply(interaction, setupConfirmation(interaction, 'مسؤولو النظام', `تم حفظ ${ids.length} عضو.`));
  }
  if (action === 'add' && parts[0] === 'role') {
    if (ids.some(id => String(id) === String(interaction.guild.id) || !interaction.guild.roles.cache.has(String(id)))) return reply(interaction, { content: 'لا يمكن إضافة @everyone أو رتبة غير موجودة كمسؤول نظام.' });
    const updated = await gm.saveSettings(interaction.guild.id, { systemRoles: [...new Set([...settings.systemRoles, ...ids.map(String)])] }, interaction.user.id);
    await refreshSetupPanel(interaction, updated);
    return reply(interaction, setupConfirmation(interaction, 'مسؤولو النظام', `تم حفظ ${ids.length} رتبة.`));
  }
  return reply(interaction, { content: 'طلب مسؤولي النظام غير صالح.' });
}
async function handleSetupSelection(interaction, prefix, action) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  const settings = await checkSystem(interaction);
  if (!settings) return true;
  if (prefix === 'groups_setup_clear_select') {
    const key = String(interaction.values?.[0] || '');
    const field = CLEARABLE_SETUP_FIELDS.find(([name]) => name === key);
    if (!field) return reply(interaction, { content: 'حقل الإعداد غير صالح.' });
    const required = ['chatMode', 'textCategoryId', 'voiceCategoryId'].includes(key);
    const patch = { [key]: null };
    if (required && settings.enabled) patch.enabled = false;
    const updated = await gm.saveSettings(interaction.guild.id, patch, interaction.user.id);
    await refreshSetupPanel(interaction, updated);
    return reply(interaction, setupConfirmation(interaction, 'مسح إعداد', `تم مسح ${field[1]}${required && settings.enabled ? '، وتم إيقاف النظام حتى تكتمل إعادة الإعداد' : ''}.`));
  }
  if (prefix === 'groups_setup_select') {
    const value = String(interaction.values?.[0] || '');
    let patch;
    let text;
    if (action === 'chatmode' && ['threads', 'channels'].includes(value)) {
      patch = { chatMode: value };
      text = `تم حفظ نمط الشات: ${value === 'threads' ? 'ثريدات' : 'رومات مستقلة'}.`;
    } else if (action === 'scope' && ['group', 'all'].includes(value)) {
      patch = { countAllChannels: value === 'all' };
      text = `تم حفظ نطاق النقاط: ${value === 'all' ? 'كل الرومات' : 'رومات القروبات فقط'}.`;
    } else return reply(interaction, { content: 'الخيار المحدد غير صالح.' });
    const updated = await gm.saveSettings(interaction.guild.id, patch, interaction.user.id);
    await refreshSetupPanel(interaction, updated);
    return reply(interaction, setupConfirmation(interaction, 'إعدادات القروبات', text));
  }
  if (prefix === 'groups_setup_role') {
    if (!['mainrole', 'leaderrole', 'managerrole'].includes(action)) return reply(interaction, { content: 'نوع الرتبة غير صالح.' });
    const roleId = String(interaction.values?.[0] || '');
    const role = interaction.guild.roles.cache.get(roleId) || await interaction.guild.roles.fetch(roleId).catch(() => null);
    if (!role || role.id === interaction.guild.id || role.managed || !role.editable) return reply(interaction, { content: 'اختر رتبة قابلة للإدارة، ولا يمكن استخدام @everyone أو الرتب المُدارة.' });
    const dangerous = [PermissionsBitField.Flags.Administrator, PermissionsBitField.Flags.ManageGuild, PermissionsBitField.Flags.ManageRoles, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ManageWebhooks, PermissionsBitField.Flags.KickMembers, PermissionsBitField.Flags.BanMembers, PermissionsBitField.Flags.ModerateMembers];
    if (['leaderrole', 'managerrole'].includes(action) && role.permissions.any(dangerous)) return reply(interaction, { content: 'هذه الرتبة تملك صلاحيات إدارية حساسة. اختر رتبة مخصصة للقروبات دون صلاحيات إدارة السيرفر.' });
    if ((action === 'leaderrole' && roleId === String(settings.managerRoleId || '')) || (action === 'managerrole' && roleId === String(settings.leaderRoleId || ''))) return reply(interaction, { content: 'يجب أن تكون رتبة مالك القروب مختلفة عن رتبة مسؤول القروب.' });
    const keys = { mainrole: 'mainRoleId', leaderrole: 'leaderRoleId', managerrole: 'managerRoleId' };
    const labels = { mainrole: 'Main Role', leaderrole: 'Leader Role', managerrole: 'Manager Role' };
    const oldRoleId = settings[keys[action]] ? String(settings[keys[action]]) : null;
    const groups = await gm.listGroups(interaction.guild.id);
    const entitled = new Set(action === 'leaderrole'
      ? groups.map(group => String(group.owner_id))
      : action === 'managerrole' ? groups.flatMap(group => group.managerIds.map(String)) : []);
    const updated = await gm.saveSettings(interaction.guild.id, { [keys[action]]: roleId }, interaction.user.id);
    if (['leaderrole', 'managerrole'].includes(action)) {
      for (const userId of entitled) {
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (member && !member.roles.cache.has(roleId)) await member.roles.add(role, 'Sync configured group role').catch(() => null);
      }
      const oldRoleStillConfigured = (action === 'leaderrole' && oldRoleId === String(settings.managerRoleId || '')) || (action === 'managerrole' && oldRoleId === String(settings.leaderRoleId || ''));
      if (oldRoleId && oldRoleId !== roleId && !oldRoleStillConfigured) {
        const oldRole = interaction.guild.roles.cache.get(oldRoleId) || await interaction.guild.roles.fetch(oldRoleId).catch(() => null);
        if (oldRole) {
          await interaction.guild.members.fetch().catch(() => null);
          for (const member of oldRole.members.values()) {
            const stillEntitled = groups.some(group => action === 'leaderrole'
              ? String(group.owner_id) === String(member.id)
              : group.managerIds.includes(String(member.id)));
            if (!stillEntitled) await member.roles.remove(oldRole, 'Remove replaced group role').catch(() => null);
          }
        }
      }
    }
    await refreshSetupPanel(interaction, updated);
    return reply(interaction, setupConfirmation(interaction, labels[action], `تم حفظ ${labels[action]}: <@&${roleId}>.`));
  }
  if (prefix === 'groups_setup_channel') {
    const channelId = String(interaction.values?.[0] || '');
    const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) return reply(interaction, { content: 'الروم المحدد غير موجود في السيرفر.' });
    const categoryActions = ['textcat', 'voicecat'];
    const textActions = ['log', 'topchannel', 'adminchannel', 'memberchannel'];
    if (categoryActions.includes(action) && channel.type !== ChannelType.GuildCategory) return reply(interaction, { content: 'اختر كاتاقوري للقنوات.' });
    if (action === 'music' && channel.type !== ChannelType.GuildVoice) return reply(interaction, { content: 'اختر رومًا صوتيًا عاديًا لمصدر الموسيقى.' });
    if (textActions.includes(action) && channel.type !== ChannelType.GuildText) return reply(interaction, { content: 'اختر رومًا نصيًا عاديًا.' });
    const keys = { textcat: 'textCategoryId', voicecat: 'voiceCategoryId', music: 'musicChannelId', topchannel: 'topChannelId', adminchannel: 'adminControlChannelId', memberchannel: 'memberControlChannelId', log: 'logChannelId' };
    if (!keys[action]) return reply(interaction, { content: 'نوع الروم غير صالح.' });
    const labels = { textcat: 'كاتاقوري النص', voicecat: 'كاتاقوري الصوت', music: 'مصدر الموسيقى', topchannel: 'روم الترتيب', adminchannel: 'روم تحكم الإدارة', memberchannel: 'روم تحكم الأعضاء', log: 'روم السجلات' };
    const updated = await gm.saveSettings(interaction.guild.id, { [keys[action]]: channelId }, interaction.user.id);
    let resultText = `تم حفظ ${labels[action]}: <#${channelId}>.`;
    try {
      if (action === 'adminchannel') {
        await sendAdminControlPanel(channel, interaction.guild);
        resultText += ' وتم نشر لوحة تحكم الإدارة في القناة.';
      } else if (action === 'topchannel') {
        await sendTopGroupsPanel(channel, interaction.guild, { channelId });
        resultText += ' وتم نشر لوحة التوب في القناة.';
      } else if (action === 'memberchannel') {
        const result = await sendMemberControlPanels(channel, interaction.guild);
        resultText += result.total
          ? ` تم تحديث لوحات ${result.published} من ${result.total} قروب نشط${result.failed ? `، وتعذر إرسال ${result.failed}` : ''}${result.overview ? '.' : '، وتعذر إرسال لوحة الملخص.'}`
          : result.overview ? ' وتم نشر لوحة توضيحية؛ ستظهر لوحات القروبات عند إنشائها.' : ' لا توجد قروبات نشطة بعد، وتعذر إرسال لوحة الملخص.';
      }
    } catch (error) {
      console.error(`تعذر نشر لوحة ${action} في ${channelId}:`, error?.stack || error?.message || error);
      resultText += ' حُفظت القناة لكن تعذر نشر اللوحة؛ تحقق من View Channel وSend Messages، ومن Attach Files للوحة التوب، ثم أعد تحديد القناة.';
    }
    await refreshSetupPanel(interaction, updated);
    return reply(interaction, setupConfirmation(interaction, labels[action], resultText));
  }
  return false;
}
async function handleAdmin(interaction, action) { const settings=await checkSystem(interaction);if(!settings)return true; if(action==='create')return interaction.showModal(createGroupModal(interaction.user.id)); if(action==='delete'||action==='info'||action==='edit'||action==='reset'){const groups=(await gm.listGroups(interaction.guild.id,action==='delete')).filter(g=>g.status==='active'||(action==='delete'&&g.status==='orphaned')); if(!groups.length)return reply(interaction,{content:'لا توجد قروبات متاحة.'});const opts=groups.slice(0,25).map(g=>({label:safe(g.name,90),value:String(g.id),description:`${Number(g.points||0).toLocaleString()} points${g.status==='orphaned'?' • يحتاج تنظيف':''}`}));return reply(interaction,selectPayload(interaction.guild,action==='delete'?'حذف قروب':action==='reset'?'تصفير النقاط':'اختر قروبًا','اختر قروبًا واحدًا.',`groups_admin_select:${action}`,opts));}if(action==='resetall'){const c=baseContainer(interaction.guild,'تصفير كل النقاط','سيتم تصفير نقاط كل القروبات النشطة.');c.addActionRowComponents(new ActionRowBuilder().addComponents(button('groups_admin_confirm:resetall','تأكيد',ButtonStyle.Danger),button('groups_admin_cancel','إلغاء')));return reply(interaction,componentsV2Payload(c));}return true; }
async function handleMember(interaction, action, groupId) { const settings=await gm.getSettings(interaction.guild.id); let group=groupId>0?await gm.getGroup(interaction.guild.id,groupId):null; if(!group){const groups=await gm.listGroups(interaction.guild.id);group=selectMemberGroup(groups,interaction.user.id,interaction.channelId);} if(!group)return reply(interaction,{content:'لا يوجد قروب مرتبط بعضويتك في هذا السيرفر.'});if(!gm.canManageGroup(interaction.client,settings,group,interaction.member)&&!group.memberIds.includes(String(interaction.user.id)))return deny(interaction,'هذه اللوحة متاحة لأعضاء القروب ومالكه ومسؤوليه فقط.');if(action==='info'){const owner=await interaction.guild.members.fetch(group.owner_id).catch(()=>null);const managers=await Promise.all(group.managerIds.map(id=>interaction.guild.members.fetch(id).catch(()=>null)));const attachment=await renderInfo({guild:interaction.guild,group,owner,managers:managers.filter(Boolean),accentColor:null});return reply(interaction,{files:[attachment]});}return true;}
async function handleRulesInteraction(interaction, action, parts = []) {
  const settings = await checkSystem(interaction);
  if (!settings) return true;
  const metric = String(parts[0] || '').toLowerCase();
  const definition = RULE_METRICS.find(([key]) => key === metric);
  if (!definition) return reply(interaction, { content: 'قاعدة النقاط غير معروفة.' });
  const rules = await gm.getRules(interaction.guild.id);
  const current = rules.find(rule => String(rule.metric) === metric);
  if (action === 'edit') {
    const modal = new ModalBuilder().setCustomId(`groups_rules_modal:edit:${metric}`).setTitle(`تعديل قاعدة ${definition[1]}`);
    modal.addLabelComponents(new LabelBuilder().setLabel('الحد').setTextInputComponent(new TextInputBuilder().setCustomId('threshold').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(current?.threshold || definition[3])).setMaxLength(12)));
    modal.addLabelComponents(new LabelBuilder().setLabel('النقاط').setTextInputComponent(new TextInputBuilder().setCustomId('points').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(current?.points || 1)).setMaxLength(8)));
    return interaction.showModal(modal);
  }
  if (action === 'toggle') {
    const enabled = Number(current?.enabled) !== 1;
    await gm.setRule(interaction.guild.id, metric, Number(current?.threshold || definition[3]), Number(current?.points || 1), enabled, interaction.user.id);
    await gm.logGroupEvent(interaction.guild, enabled ? 'rule_enable' : 'rule_disable', { metric, threshold: Number(current?.threshold || definition[3]), points: Number(current?.points || 1) }, interaction.user.id);
    await refreshSetupPanel(interaction, settings);
    return reply(interaction, rulesPayload(interaction.guild, await gm.getRules(interaction.guild.id)));
  }
  return reply(interaction, rulesPayload(interaction.guild, rules));
}

async function transferGroupOwner(interaction, groupId, ownerId) {
  return groupOperation(`group:${interaction.guild.id}:${groupId}`, async () => {
    const settings = await gm.getSettings(interaction.guild.id);
    const actor = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    const group = await gm.getGroup(interaction.guild.id, Number(groupId));
    if (!actor || (String(group?.owner_id) !== String(interaction.user.id) && !gm.canManageSystem(interaction.client, settings, actor))) throw new Error('OWNER_ONLY');
    const targetId = String(ownerId || '');
    if (!group || group.status !== 'active' || !group.memberIds.includes(targetId)) throw new Error('OWNER_MUST_BE_MEMBER');
    if (String(group.owner_id) === targetId) return 'العضو هو مالك القروب الحالي بالفعل.';
    const groups = await gm.listGroups(interaction.guild.id);
    if (groups.some(item => item.id !== group.id && (String(item.owner_id) === targetId || item.memberIds.includes(targetId) || item.managerIds.includes(targetId)))) throw new Error('USER_ALREADY_IN_GROUP');
    const newOwner = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!newOwner || newOwner.user.bot) throw new Error('MEMBER_NOT_FOUND');
    const oldOwnerId = String(group.owner_id);
    const nextManagers = group.managerIds.filter(id => id !== targetId);
    // Keep the former owner as a regular member so they can explicitly leave afterward.
    const nextMembers = [...new Set([...group.memberIds, oldOwnerId, targetId])].filter(id => id !== targetId || id === oldOwnerId);
    const nextBlocked = group.blockedIds.filter(id => id !== targetId);
    await gm.updateGroup(interaction.guild.id, group.id, {
      owner_id: targetId,
      manager_ids_json: JSON.stringify(nextManagers),
      member_ids_json: JSON.stringify(nextMembers),
      blocked_ids_json: JSON.stringify(nextBlocked),
      updated_at: Date.now()
    }, interaction.user.id);
    invalidateGroupCaches(interaction.guild.id);
    const warnings = [];
    const leader = settings.leaderRoleId && (interaction.guild.roles.cache.get(settings.leaderRoleId) || await interaction.guild.roles.fetch(settings.leaderRoleId).catch(() => null));
    if (settings.leaderRoleId && !leader) warnings.push('تعذر العثور على رتبة المالك');
    if (leader) {
      if (!newOwner.roles.cache.has(leader.id)) await newOwner.roles.add(leader, 'نقل ملكية القروب').catch(() => warnings.push('تعذر إضافة رتبة المالك للمالك الجديد'));
      const oldOwner = await interaction.guild.members.fetch(oldOwnerId).catch(() => null);
      const otherGroups = await gm.listGroups(interaction.guild.id);
      if (oldOwner && !otherGroups.some(item => String(item.owner_id) === oldOwnerId)) await oldOwner.roles.remove(leader, 'نقل ملكية القروب').catch(() => warnings.push('تعذر إزالة رتبة المالك من المالك السابق'));
    }
    if (settings.managerRoleId && group.managerIds.includes(targetId)) {
      const managerRole = interaction.guild.roles.cache.get(settings.managerRoleId) || await interaction.guild.roles.fetch(settings.managerRoleId).catch(() => null);
      const stillManager = (await gm.listGroups(interaction.guild.id)).some(item => item.managerIds.includes(targetId));
      if (managerRole && !stillManager) await newOwner.roles.remove(managerRole, 'Owner promoted from group manager').catch(() => warnings.push('تعذر إزالة رتبة مسؤول القروب من المالك الجديد'));
    }
    await gm.logGroupEvent(interaction.guild, 'owner', { groupId: group.id, from: oldOwnerId, to: targetId, warnings }, interaction.user.id);
    return warnings.length ? `تم نقل الملكية، لكن يلزم مراجعة الرتب: ${warnings.join('؛ ')}.` : 'تم نقل الملكية.';
  });
}
async function handleInteraction(interaction) { const extended=await handleGroupExtensions(interaction); if(extended!==false)return extended; const [prefix,action,...parts]=String(interaction.customId||'').split(':'); if(prefix==='groups_top'&&['rank','group','manage','refresh','leave','leave-confirm','leave-cancel','transfer','transfer-select'].includes(action))return handleTopGroupsInteraction(interaction,action,parts); if(prefix==='groups_bonus')return handleTopBonusButton(interaction,action); if(prefix==='groups_bonus_select')return handleTopBonusSelection(interaction,action,parts); if(prefix==='groups_bonus_page')return handleTopBonusPage(interaction,action,parts); if(prefix==='groups_bonus_member_select')return handleTopBonusMemberSelection(interaction,action,parts); if(prefix==='groups_bonus_modal')return handleTopBonusModal(interaction,action,parts); if(prefix==='groups_bonus_confirm')return handleTopBonusConfirm(interaction,action,parts); if(prefix==='groups_rules_modal'){const metric=parts[0];const settings=await checkSystem(interaction);if(!settings)return true;const definition=RULE_METRICS.find(([key])=>key===metric);if(!definition)return reply(interaction,{content:'قاعدة النقاط غير معروفة.'});try{const rules=await gm.getRules(interaction.guild.id);const current=rules.find(rule=>String(rule.metric)===metric);const threshold=Number(interaction.fields.getTextInputValue('threshold'));const points=Number(interaction.fields.getTextInputValue('points'));await gm.setRule(interaction.guild.id,metric,threshold,points,Number(current?.enabled)===1,interaction.user.id);await gm.logGroupEvent(interaction.guild,'rule_update',{metric,threshold,points,enabled:Number(current?.enabled)===1},interaction.user.id);await refreshSetupPanel(interaction,settings);return reply(interaction,rulesPayload(interaction.guild,await gm.getRules(interaction.guild.id)));}catch(error){return reply(interaction,{content:`تعذر حفظ القاعدة : ${error.message}`});}} if(prefix==='groups_modal'){ if(action==='create') return createFromModal(interaction); if(action==='edit'){if(!await checkSystem(interaction))return true;const groupId=Number(parts[0]);const field=choose(parts[1],['name','description','color','emoji']);const group=await gm.getGroup(interaction.guild.id,groupId);if(!group||group.status!=='active')return reply(interaction,{content:'القروب غير موجود.'});await interaction.deferReply({flags:MessageFlags.Ephemeral});const value=safe(interaction.fields.getTextInputValue('value'),field==='description'?500:field==='name'?80:100).trim();if(field==='name')await renameGroupResources(interaction,group,'name',value);else{if(field==='color'&&!/^#[0-9a-f]{6}$/i.test(value))return reply(interaction,{content:'استخدم لونًا بصيغة ست خانات، مثل #5865F2.'});await gm.updateGroup(interaction.guild.id,groupId,{[field]:value,updated_at:Date.now()},interaction.user.id);}invalidateGroupCaches(interaction.guild.id);await gm.logGroupEvent?.(interaction.guild,'update',{groupId,field,value},interaction.user.id);return reply(interaction,{content:'تم تحديث القروب.'});} return false; } if(prefix==='groups_setup')return handleSetup(interaction,action); if(prefix==='groups_rules')return handleRulesInteraction(interaction,action,parts); if(prefix==='groups_admin')return handleAdmin(interaction,action); if(prefix==='groups_member')return handleMember(interaction,action,Number(parts[0])); if(prefix==='groups_setup_clear_select'){return handleSetupSelection(interaction,prefix,action);} if(prefix==='groups_setup_select'){return handleSetupSelection(interaction,prefix,action);} if(prefix==='groups_setup_role'){return handleSetupSelection(interaction,prefix,action);} if(prefix==='groups_setup_channel'){return handleSetupSelection(interaction,prefix,action);} if(prefix==='groups_setup_manager')return handleSetupManager(interaction,action,parts); if(prefix==='groups_admin_select'){const settings=await checkSystem(interaction);if(!settings)return true;const groupId=Number(interaction.values[0]);if(action==='reset'){await gm.resetPoints(interaction.guild.id,groupId,interaction.user.id);return reply(interaction,{content:'تم تصفير نقاط القروب.'});}if(action==='delete'){const group=await gm.getGroup(interaction.guild.id,groupId);const c=baseContainer(interaction.guild,'تأكيد الحذف',`القروب : **${safe(group?.name)}**\nسيتم حذف قنوات ورول القروب.`);c.addActionRowComponents(new ActionRowBuilder().addComponents(button(`groups_admin_confirm:delete:${groupId}`,'تأكيد',ButtonStyle.Danger),button('groups_admin_cancel','إلغاء')));return reply(interaction,componentsV2Payload(c));}if(action==='info'){const g=await gm.getGroup(interaction.guild.id,groupId);if(!g)return reply(interaction,{content:'القروب غير موجود.'});const owner=await interaction.guild.members.fetch(g.owner_id).catch(()=>null);const managers=await Promise.all(g.managerIds.map(id=>interaction.guild.members.fetch(id).catch(()=>null)));const attachment=await renderInfo({guild:interaction.guild,group:g,owner,managers:managers.filter(Boolean),accentColor:null});return reply(interaction,{files:[attachment]});}if(action==='edit'){return reply(interaction,selectPayload(interaction.guild,'تعديل القروب','اختر الحقل المطلوب.',`groups_edit_field:${groupId}`,[{label:'الاسم',value:'name'},{label:'الوصف',value:'description'},{label:'اللون',value:'color'},{label:'الإيموجي',value:'emoji'},{label:'المالك',value:'owner'}]));}} if(prefix==='groups_edit_field'){const groupId=Number(action);const field=choose(interaction.values?.[0],['name','description','color','emoji','owner']);if(!await checkSystem(interaction))return true;if(field==='owner'){const menu=new UserSelectMenuBuilder().setCustomId(`groups_edit_owner:${groupId}`).setPlaceholder('اختر المالك الجديد').setMinValues(1).setMaxValues(1);const c=baseContainer(interaction.guild,'نقل الملكية','اختر عضوًا حاليًا من القروب.');c.addActionRowComponents(new ActionRowBuilder().addComponents(menu));return reply(interaction,componentsV2Payload(c));}const modal=new ModalBuilder().setCustomId(`groups_modal:edit:${groupId}:${field}`).setTitle(`تعديل ${field}`);modal.addLabelComponents(new LabelBuilder().setLabel(field).setTextInputComponent(new TextInputBuilder().setCustomId('value').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(field==='description'?500:100)));return interaction.showModal(modal);} if(prefix==='groups_edit_owner'){if(!await checkSystem(interaction))return true;try{return reply(interaction,{content:await transferGroupOwner(interaction,Number(action),interaction.values?.[0])});}catch(error){const message=error.message==='OWNER_MUST_BE_MEMBER'?'يجب أن يكون المالك الجديد عضوًا نشطًا في القروب.':error.message==='USER_ALREADY_IN_GROUP'?'المالك المختار مرتبط بقروب نشط آخر.':'تعذر نقل الملكية.';return reply(interaction,{content:message});}} if(prefix==='groups_admin_confirm'){const settings=await checkSystem(interaction);if(!settings)return true;if(action==='resetall'){await gm.resetPoints(interaction.guild.id,null,interaction.user.id);return reply(interaction,{content:'تم تصفير نقاط كل القروبات.'});}if(action==='delete'){const deletedGroup=await gm.getGroup(interaction.guild.id,Number(parts[0]));try{await gm.deleteGroup(interaction.guild,Number(parts[0]),interaction.user.id);}catch(error){return reply(interaction,{content:error.message==='GROUP_DELETE_PARTIAL'?'تعذر حذف بعض عناصر القروب؛ تم حفظ حالته للتنظيف. أعد محاولة الحذف من لوحة الإدارة.':'تعذر حذف القروب.'});}await gm.logGroupEvent(interaction.guild,'delete',{groupId:Number(parts[0]),name:deletedGroup?.name||null},interaction.user.id);return reply(interaction,{content:'تم حذف القروب.'});}} if(prefix==='groups_admin_cancel')return reply(interaction,{content:'تم الإلغاء.'}); return false; }
function createLauncherPayload(guild, customId, disabled = false) {
  const c = baseContainer(guild, 'إنشاء قروب', 'افتح النموذج لإنشاء القروب. بعد الإنشاء يصل دليل الأوامر لمالكه.');
  c.addActionRowComponents(new ActionRowBuilder().addComponents(
    button(customId, 'إنشاء', ButtonStyle.Secondary, '<:emoji_33:1465383525644501238>').setDisabled(disabled)
  ));
  return componentsV2Payload(c);
}
async function sendCreateCommandPanel(message) {
  const customId = `group_create_launch:${message.author.id}:${Math.random().toString(36).slice(2, 9)}`;
  const sent = await message.channel.send(createLauncherPayload(message.guild, customId));
  if (typeof sent?.createMessageComponentCollector !== 'function') return sent;
  let busy = false;
  let used = false;
  const disableButton = () => sent.edit(createLauncherPayload(message.guild, customId, true)).catch(() => null);
  const collector = sent.createMessageComponentCollector({
    filter: interaction => interaction.customId === customId,
    time: 60_000
  });
  collector.on('collect', async interaction => {
    if (String(interaction.user?.id) !== String(message.author.id)) {
      return interaction.reply(responsePayload({ content: 'هذا الزر متاح لمنشئ الأمر فقط.', ephemeral: true })).catch(() => null);
    }
    if (busy || used) return interaction.reply(responsePayload({ content: 'تم استخدام هذا الزر أو أن الطلب قيد المعالجة.', ephemeral: true })).catch(() => null);
    busy = true;
    try {
      const settings = await gm.getSettings(interaction.guild.id);
      if (!gm.canManageSystem(interaction.client, settings, interaction.member)) {
        busy = false;
        return interaction.reply(responsePayload({ content: 'لا تملك صلاحية إدارة القروبات.', ephemeral: true }));
      }
      await interaction.showModal(createGroupModal(interaction.user.id));
      used = true;
      collector.stop('used');
      await disableButton();
    } catch (error) {
      busy = false;
      console.error('[groups] create command collector failed:', error?.message || error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply(responsePayload({ content: 'تعذر فتح نموذج إنشاء القروب. أعد تنفيذ الأمر.', ephemeral: true })).catch(() => null);
      }
    }
  });
  collector.on('end', () => {
    if (!used) void disableButton();
  });
  return sent;
}
async function execute(message, args, { client } = {}) {
  if (!message.guild) return;
  const settings = await gm.getSettings(message.guild.id);
  const member = message.member;
  const sub = String(args[0] || '').toLowerCase();
  const canManage = gm.canManageSystem(client, settings, member);

  if (sub === 'setup' || sub === 'إعدادات') {
    if (!canManage) return replyMessage(message,'لا تملك الصلاحية.');
    return sendSetupPanel(message.channel, message.guild, settings);
  }
  if (sub === 'control' || sub === 'تحكم') {
    if (!canManage) return replyMessage(message,'لا تملك الصلاحية.');
    const target = settings.adminControlChannelId && message.guild.channels.cache.get(settings.adminControlChannelId);
    return sendAdminControlPanel(target || message.channel, message.guild);
  }
  if (['rules', 'قواعد'].includes(sub)) {
    if (!canManage) return replyMessage(message,'لا تملك الصلاحية.');
    if (!args[1]) return message.channel.send(rulesPayload(message.guild, await gm.getRules(message.guild.id)));
    const metricName = String(args[1]).toLowerCase();
    const metric = metricName === 'voice' ? 'voice_ms' : ['reaction', 'reactions'].includes(metricName) ? 'reactions' : 'messages';
    const threshold = Number(args[2] || 100);
    const points = Number(args[3] || 1);
    await gm.setRule(message.guild.id, metric, threshold, points, true, message.author.id);
    await gm.logGroupEvent(message.guild, 'rule_update', { metric, threshold, points, enabled: true }, message.author.id);
    return replyMessage(message,`تم حفظ القاعدة : ${metric} / ${threshold} / ${points}`);
  }
  if (['create', 'انشاء', 'إنشاء'].includes(sub)) {
    if (!canManage) return replyMessage(message,'لا تملك الصلاحية.');
    return sendCreateCommandPanel(message);
  }
  if (['delete', 'حذف'].includes(sub)) {
    if (!canManage) return replyMessage(message,'لا تملك الصلاحية.');
    const groups = (await gm.listGroups(message.guild.id, true))
      .filter(group => group.status === 'active' || group.status === 'orphaned');
    if (!groups.length) return replyMessage(message,'لا توجد قروبات متاحة للحذف.');

    const target = args.slice(1).join(' ').trim();
    let choices = groups;
    if (target) {
      const roleId = target.match(/^<@&(\d{16,20})>$/)?.[1] || (/^\d{16,20}$/.test(target) ? target : null);
      const normalizedTarget = target.toLocaleLowerCase();
      choices = groups.filter(group =>
        (roleId && (String(group.role_id) === roleId || String(group.id) === roleId))
        || String(group.id) === target
        || String(group.name || '').toLocaleLowerCase() === normalizedTarget
      );
      if (!choices.length) {
        choices = groups.filter(group => String(group.name || '').toLocaleLowerCase().includes(normalizedTarget));
      }
      if (!choices.length) return replyMessage(message,'لم أجد قروبًا مطابقًا للاسم أو المعرف المحدد.');
    }

    const options = choices.slice(0, 25).map(group => ({
      label: safe(group.name || `Group ${group.id}`, 90),
      value: String(group.id),
      description: `${Number(group.points || 0).toLocaleString()} points${group.status === 'orphaned' ? ' • يحتاج تنظيف' : ''}`.slice(0, 100)
    }));
    const limitNote = choices.length > 25
      ? ` عُرض أول 25 من ${choices.length} نتيجة؛ حدّد اسمًا أدق أو معرف القروب.`
      : '';
    const payload = selectPayload(
      message.guild,
      'حذف قروب',
      `اختر القروب المطلوب. ستظهر خطوة تأكيد قبل حذف الرتبة والقنوات المرتبطة به.${limitNote}`,
      'groups_admin_select:delete',
      options
    );
    return message.channel.send({ ...payload, allowedMentions: { parse: [] } });
  }
  if (['top', 'leaderboard', 'ranking', 'rank', 'ترتيب', 'تصنيف'].includes(sub)) {
    const target = settings.topChannelId && message.guild.channels.cache.get(settings.topChannelId);
    return sendTopGroupsPanel(target || message.channel, message.guild, { channelId: (target || message.channel).id });
  }
  if (['members', 'اعضاء'].includes(sub)) {
    const group = selectMemberGroup(await gm.listGroups(message.guild.id), message.author.id, message.channel.id);
    if (!group) return replyMessage(message,'لا يوجد قروب نشط.');
    const full = await gm.getGroup(message.guild.id, group.id);
    const rows = await gm.listMemberPoints(message.guild.id, group.id, 10);
    const members = await Promise.all(rows.map(async row => ({
      ...row,
      member: await message.guild.members.fetch(row.user_id).catch(() => null)
    })));
    return message.channel.send({ files: [await renderMembers({ guild: message.guild, group: full, members, accentColor: null })] });
  }
  return replyMessage(message,'استخدم أمر القروبات مع الخيارات: setup، control، create، delete، top، members أو rules.');
}
const activityCache=new Map(); const settingsCache=new Map(); const voiceStarts=new Map(); const lastMessageAt=new Map();
async function cachedGroups(guildId){const hit=activityCache.get(String(guildId));if(hit&&Date.now()-hit.at<30000)return hit.groups;const groups=await gm.listGroups(guildId);activityCache.set(String(guildId),{at:Date.now(),groups});return groups;}
async function cachedSettings(guildId){const hit=settingsCache.get(String(guildId));if(hit&&Date.now()-hit.at<30000)return hit.settings;const settings=await gm.getSettings(guildId);settingsCache.set(String(guildId),{at:Date.now(),settings});return settings;}
function registerInteractionHandler(client) {
  if (registered) return;
  registered = true;
  router.register('groups_', handleInteraction, { name: 'groups', priority: 95, types: ['button', 'modal', 'stringSelect', 'userSelect', 'roleSelect', 'channelSelect'] });

  // Never bulk-delete ordinary messages here. A previous heuristic removed every
  // non-bot message without components, which destroyed normal group conversations.
  client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;
    const settings = await cachedSettings(message.guild.id).catch(() => null);
    if (!settings?.enabled) return;
    const groups = await cachedGroups(message.guild.id);
    const userId = String(message.author.id);
    const eligible = groups.some(group =>
      (group.memberIds.includes(userId) || String(group.owner_id) === userId || group.managerIds.includes(userId))
      && (settings.countAllChannels || gm.channelBelongs(group, message.channelId))
    );
    if (!eligible) return;
    const key = `${message.guild.id}:${userId}:${message.channelId}`;
    const now = Date.now();
    if (now - Number(lastMessageAt.get(key) || 0) < 60000) return;
    lastMessageAt.set(key, now);
    if (lastMessageAt.size > 10000) for (const [entry, time] of lastMessageAt) if (now - time > 600000) lastMessageAt.delete(entry);
    await gm.recordActivity(message.guild.id, userId, 'messages', 1, message.channelId).catch(() => {});
  });

  client.on('messageReactionAdd', async (reaction, user) => {
    const guild = reaction?.message?.guild;
    if (user?.bot || !guild) return;
    const settings = await cachedSettings(guild.id).catch(() => null);
    if (!settings?.enabled) return;
    const groups = await cachedGroups(guild.id);
    if (groups.some(group =>
      (group.memberIds.includes(String(user.id)) || String(group.owner_id) === String(user.id) || group.managerIds.includes(String(user.id)))
      && (settings.countAllChannels || gm.channelBelongs(group, reaction.message.channelId))
    )) {
      const emojiKey = reaction.emoji?.id || reaction.emoji?.name || 'unknown';
      const eventId = `${reaction.message.id}:${emojiKey}`;
      await gm.recordActivity(guild.id, user.id, 'reactions', 1, reaction.message.channelId, eventId).catch(() => {});
    }
  });

  client.on('voiceStateUpdate', async (oldState, newState) => {
    const guildId = newState.guild?.id || oldState.guild?.id;
    if (!guildId) return;
    const groups = await cachedGroups(guildId);
    const memberId = String(newState.id || oldState.id);
    const eligible = group => group && (group.memberIds.includes(memberId) || String(group.owner_id) === memberId || group.managerIds.includes(memberId));
    const oldGroup = groups.find(group => group.voice_channel_id && group.voice_channel_id === oldState.channelId && eligible(group));
    const newGroup = groups.find(group => group.voice_channel_id && group.voice_channel_id === newState.channelId && eligible(group));
    const key = `${guildId}:${memberId}`;
    if (oldGroup && (!newGroup || oldGroup.id !== newGroup.id)) {
      const started = voiceStarts.get(key);
      if (started) await gm.recordActivity(guildId, memberId, 'voice_ms', Date.now() - started, oldState.channelId).catch(() => {});
      voiceStarts.delete(key);
    }
    if (newGroup && (!oldGroup || oldGroup.id !== newGroup.id)) voiceStarts.set(key, Date.now());
    if (!oldGroup && !newGroup) voiceStarts.delete(key);
  });

  client.on('channelDelete', async channel => {
    if (!channel.guild) return;
    const groups = (await gm.listGroups(channel.guild.id, true)).filter(group => group.status !== 'deleted');
    for (const group of groups) {
      const patch = {};
      if (group.text_channel_id === channel.id) patch.text_channel_id = null;
      if (group.thread_id === channel.id) patch.thread_id = null;
      if (group.voice_channel_id === channel.id) patch.voice_channel_id = null;
      if (Object.keys(patch).length) {
        patch.status = 'orphaned';
        patch.updated_at = Date.now();
        await gm.updateGroup(channel.guild.id, group.id, patch, null).catch(() => {});
        await gm.audit(channel.guild.id, null, group.id, 'linked_channel_deleted', { channelId: channel.id, status: 'orphaned' }).catch(() => {});
        await gm.logGroupEvent(channel.guild, 'update', { groupId: group.id, reason: 'linked_channel_deleted', channelId: channel.id, status: 'orphaned' }, null);
      }
    }
    activityCache.delete(String(channel.guild.id));
  });

  client.on('roleDelete', async role => {
    if (!role.guild) return;
    const groups = (await gm.listGroups(role.guild.id, true)).filter(group => group.status !== 'deleted');
    for (const group of groups) if (group.role_id === role.id) {
      await gm.updateGroup(role.guild.id, group.id, { role_id: null, status: 'orphaned', updated_at: Date.now() }, null).catch(() => {});
      await gm.audit(role.guild.id, null, group.id, 'linked_role_deleted', { roleId: role.id, status: 'orphaned' }).catch(() => {});
      await gm.logGroupEvent(role.guild, 'update', { groupId: group.id, reason: 'linked_role_deleted', roleId: role.id, status: 'orphaned' }, null);
    }
    activityCache.delete(String(role.guild.id));
  });

  client.on('guildMemberRemove', async member => {
    voiceStarts.delete(`${member.guild.id}:${member.id}`);
    const groups = await gm.listGroups(member.guild.id);
    for (const group of groups) {
      const userId = String(member.id);
      if (!group.memberIds.includes(userId) && String(group.owner_id) !== userId && !group.managerIds.includes(userId)) continue;
      if (String(group.owner_id) === userId) {
        const candidates = await Promise.all(group.managerIds.filter(id => id !== userId).map(id => member.guild.members.fetch(id).catch(() => null)));
        const successor = candidates.find(Boolean) || null;
        const nextMembers = group.memberIds.filter(id => id !== userId);
        const nextManagers = successor ? group.managerIds.filter(id => id !== userId && id !== successor.id) : group.managerIds.filter(id => id !== userId);
        if (successor) {
          await gm.updateGroup(member.guild.id, group.id, { owner_id: successor.id, manager_ids_json: JSON.stringify(nextManagers), member_ids_json: JSON.stringify([...new Set([...nextMembers, successor.id])]), updated_at: Date.now() }, null);
          const settings = await gm.getSettings(member.guild.id);
          const leader = settings.leaderRoleId && (member.guild.roles.cache.get(settings.leaderRoleId) || await member.guild.roles.fetch(settings.leaderRoleId).catch(() => null));
          if (leader) await successor.roles.add(leader, 'نقل ملكية القروب').catch(() => {});
          await gm.audit(member.guild.id, successor.id, group.id, 'owner_transferred', { from: userId, to: successor.id });
          await gm.logGroupEvent(member.guild, 'owner', { groupId: group.id, from: userId, to: successor.id }, successor.id);
        } else {
          await gm.updateGroup(member.guild.id, group.id, { status: 'orphaned', manager_ids_json: JSON.stringify(nextManagers), member_ids_json: JSON.stringify(nextMembers), updated_at: Date.now() }, null);
          await gm.audit(member.guild.id, null, group.id, 'owner_left', { userId, status: 'orphaned' });
          await gm.logGroupEvent(member.guild, 'owner', { groupId: group.id, from: userId, status: 'orphaned' }, null);
        }
        activityCache.delete(String(member.guild.id));
        continue;
      }
      await gm.removeMember(member.guild.id, group.id, userId, 'member_left').catch(() => {});
      await gm.logGroupEvent(member.guild, 'member_remove', { groupId: group.id, userId, reason: 'member_left' }, null);
      const owner = await member.guild.members.fetch(group.owner_id).catch(() => null);
      for (const managerId of group.managerIds) {
        const manager = await member.guild.members.fetch(managerId).catch(() => null);
        for (const recipient of [owner, manager]) if (recipient) recipient.send(`Group update\nMember: <@${userId}>\nGroup: **${safe(group.name)}**\nAction: member left`).catch(() => {});
      }
    }
    activityCache.delete(String(member.guild.id));
  });

  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    if (oldMember.roles.cache.equals(newMember.roles.cache)) return;
    const groups = await gm.listGroups(newMember.guild.id);
    for (const group of groups) {
      if (!group.role_id) continue;
      const had = oldMember.roles.cache.has(group.role_id);
      const has = newMember.roles.cache.has(group.role_id);
      const bypass = global.groupRoleGrantBypass?.has(`${newMember.guild.id}:${newMember.id}:${group.role_id}`);
      const isLinked = group.memberIds.includes(String(newMember.id)) || String(group.owner_id) === String(newMember.id) || group.managerIds.includes(String(newMember.id));
      if (has && !had && !isLinked && !bypass) {
        await newMember.roles.remove(group.role_id, 'Unapproved group role assignment').catch(() => {});
        await gm.audit(newMember.guild.id, null, group.id, 'role_guard_removed', { userId: newMember.id, roleId: group.role_id });
        await gm.logGroupEvent(newMember.guild, 'update', { groupId: group.id, reason: 'role_guard_removed', userId: newMember.id, roleId: group.role_id }, null);
      }
      if (!has && had && isLinked && String(group.owner_id) !== String(newMember.id)) {
        const voiceKey = `${newMember.guild.id}:${newMember.id}`;
        const voiceStarted = voiceStarts.get(voiceKey);
        if (voiceStarted) await gm.recordActivity(newMember.guild.id, newMember.id, 'voice_ms', Date.now() - voiceStarted, group.voice_channel_id).catch(() => {});
        voiceStarts.delete(voiceKey);
        const roleRemovalSettings = await gm.getSettings(newMember.guild.id);
        await leaveGroupMember(newMember.guild, roleRemovalSettings, group, newMember.id, 'role_removed').catch(async error => {
          await gm.audit(newMember.guild.id, null, group.id, 'role_membership_sync_failed', { userId: newMember.id, message: String(error?.message || error).slice(0, 200) }).catch(() => null);
        });
        const owner = await newMember.guild.members.fetch(group.owner_id).catch(() => null);
        for (const managerId of group.managerIds) {
          const manager = await newMember.guild.members.fetch(managerId).catch(() => null);
          for (const recipient of [owner, manager]) if (recipient) recipient.send(`Group update\nMember: <@${newMember.id}>\nGroup: **${safe(group.name)}**\nAction: role removed`).catch(() => {});
        }
      }
    }
    activityCache.delete(String(newMember.guild.id));
  });
}
async function dispatchInternalMessage(message, options = {}) {
  const prefix = Object.prototype.hasOwnProperty.call(options, 'prefix') ? options.prefix : ':';
  const content = String(message?.content || '').trim();
  const hasPrefix = typeof prefix === 'string' && prefix.length > 0 && content.startsWith(prefix);
  const raw = (hasPrefix ? content.slice(prefix.length) : content).trim();
  if(message?.guild&&!message.author?.bot) {
    const command = raw.split(/\s+/)[0].toLowerCase();
    if(command==='صلاحية'||command==='permission') {
      try {
        const linked=await gm.getGroupForChannel(message.guild.id,message.channel.id);
        if(!linked) {
          if(!hasPrefix)return false;
          throw new Error('GROUP_NOT_FOUND');
        }
        const {group}=await currentManager(message,linked.id,true);
        const flow=newFlow(message.guild.id,message.author.id,'permission',group.id);
        await replyMessage(message,{...scopePayload(message.guild,flow),allowedMentions:{parse:[]}});
      } catch(error) { await replyMessage(message,{content:groupError(error),allowedMentions:{parse:[]}}).catch(()=>null); }
      return true;
    }
  }
  return handleInternalMessage(message, { ...options, sendPanel: sendGroupPanel });
}

// Group-scoped controls. Never edit guild roles, categories, or a shared thread parent.
const { PermissionsBitField, OverwriteType } = require('discord.js');
const { randomBytes } = require('node:crypto');
const { dbManager } = require('../utils/database');
const groupFlows = new Map();
const FLOW_TTL = 10 * 60 * 1000;
const TEXT_ACCESS = ['ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'ReadMessageHistory'];
const VOICE_ACCESS = ['ViewChannel', 'Connect', 'Speak'];
const SAFE_PERMISSIONS = {
  text: [...TEXT_ACCESS, 'AddReactions', 'AttachFiles', 'EmbedLinks'],
  voice: [...VOICE_ACCESS, 'Stream', 'UseVAD'],
  both: ['ViewChannel']
};
const CONTROL_ACTIONS = new Set(['lock', 'unlock', 'hide', 'show', 'mute', 'unmute']);
function flowId(flow) { return `groups_flow:${flow.token}:${flow.step}`; }
function newFlow(guildId, actorId, kind, groupId = null) {
  const now = Date.now();
  for (const [token, flow] of groupFlows) if (flow.expires <= now) groupFlows.delete(token);
  if (groupFlows.size >= 1000) groupFlows.delete(groupFlows.keys().next().value);
  const flow = { token: randomBytes(12).toString('hex'), guildId: String(guildId), actorId: String(actorId), kind, groupId, step: 'scope', expires: now + FLOW_TTL };
  groupFlows.set(flow.token, flow);
  return flow;
}
function forgetFlow(flow) { groupFlows.delete(flow.token); }
function oneValue(interaction) {
  if (!Array.isArray(interaction.values) || interaction.values.length !== 1) throw new Error('INVALID_SELECTION');
  return String(interaction.values[0]);
}
function choose(value, allowed) { if (!allowed.includes(value)) throw new Error('INVALID_SELECTION'); return value; }
function groupError(error) {
  const messages = {
    GROUP_NOT_FOUND: 'القروب غير موجود أو لم يعد نشطاً.', NO_PERMISSION: 'ليس لديك صلاحية مالك/مسؤول لهذا القروب.',
    EXTRA_DISABLED: 'الصلاحيات الإضافية متوقفة؛ يجب تفعيلها من إعدادات القروبات أولًا.',
    FLOW_EXPIRED: 'انتهت هذه القائمة أو استُخدمت؛ افتح قائمة جديدة.', FLOW_OWNER: 'هذه القائمة تخص مستخدماً آخر.',
    INVALID_SELECTION: 'اختيار غير صالح؛ افتح القائمة مجدداً.', MEMBER_NOT_FOUND: 'العضو غير موجود في السيرفر.',
    TARGET_PROTECTED: 'لا يمكن تقييد مالك القروب أو مسؤوليه أو مديري النظام أو البوت.',
    CHANNEL_NOT_FOUND: 'قناة القروب المحددة غير موجودة أو نوعها غير صالح.',
    SHARED_CHANNEL: 'القناة/أب الثريد مشترك؛ لا يمكن تغيير صلاحياته دون التأثير على قروب أو ثريد آخر.',
    ASSET_LINKED: 'أحد العناصر أو الأعضاء المختارين مرتبط بقروب آخر؛ لم يتم الاستيراد.',
    INVALID_ROLE: 'اختر رتبة قروب عادية قابلة للإدارة، غير everyone أو رتبة نظام أو رتبة ذات صلاحيات إدارية.',
    INVALID_THREAD: 'الثريد غير موجود أو لا ينتمي إلى القناة المختارة.',
    OWNER_NOT_IN_THREAD: 'مالك القروب غير عضو في الثريد الخاص؛ أضفه إليه قبل الاستيراد.',
    THREAD_MEMBERS_MISMATCH: 'كل حاملي رتبة القروب يجب أن يكونوا أعضاء في الثريد الخاص قبل ربطه.',
    NAME_REQUIRED: 'الاسم مطلوب (حتى 80 حرفاً).', NAME_EXISTS: 'يوجد قروب آخر بهذا الاسم.',
    INVALID_LIMIT: 'الحد الصوتي عدد صحيح من 0 إلى 99 (0 = بلا حد).',
    NOT_IN_GROUP_VOICE: 'العضو ليس في روم هذا القروب؛ لن يتم فصله من أي روم آخر.',
    MISSING_PERMISSIONS: 'البوت لا يملك الصلاحيات المطلوبة في قناة القروب.',
    GROUP_FULL: 'عدد الأعضاء يتجاوز الحد المحدد للقروبات.', ACTION_BUSY: 'يوجد إجراء جارٍ لهذا القروب، حاول مجدداً.',
    THREAD_ARCHIVED: 'الثريد مؤرشف؛ افتحه من Discord قبل منح عضو الوصول إليه.'
  };
  if (String(error?.message).includes('UNIQUE constraint failed')) return messages.NAME_EXISTS;
  return messages[error?.message] || 'تعذر تنفيذ الإجراء. تحقق من صلاحيات البوت وترتيب رتبته؛ لم نمنح أي صلاحية على مستوى السيرفر.';
}
async function currentManager(context, groupId, extra = false) {
  const settings = await gm.getSettings(context.guild.id);
  const member = await context.guild.members.fetch(String(context.user?.id || context.author?.id)).catch(() => null);
  const group = await gm.getGroup(context.guild.id, Number(groupId));
  if (!group || group.status !== 'active') throw new Error('GROUP_NOT_FOUND');
  if (!gm.canManageGroup(context.client, settings, group, member)) throw new Error('NO_PERMISSION');
  if (extra && !settings.extraPermissions) throw new Error('EXTRA_DISABLED');
  return { settings, member, group };
}
async function currentSystem(interaction) {
  const settings = await gm.getSettings(interaction.guild.id);
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!gm.canManageSystem(interaction.client, settings, member)) throw new Error('NO_PERMISSION');
  return settings;
}
async function groupOperation(key, operation) {
  if (locks.has(key)) throw new Error('ACTION_BUSY');
  locks.add(key);
  try { return await operation(); } finally { locks.delete(key); }
}
function invalidateGroupCaches(guildId) { activityCache.delete(String(guildId)); settingsCache.delete(String(guildId)); }
async function channelById(guild, id) { return id ? guild.channels.fetch(String(id)).catch(() => null) : null; }
async function threadChoices(parent) {
  const found = new Map();
  const active = await parent.threads.fetchActive();
  for (const thread of active.threads.values()) found.set(thread.id, thread);
  for (const type of ['public', 'private']) {
    let before;
    for (;;) {
      const page = await parent.threads.fetchArchived({ type, fetchAll: true, limit: 100, ...(before ? { before } : {}) });
      const values = [...page.threads.values()];
      for (const thread of values) found.set(thread.id, thread);
      if (!page.hasMore || !values.length) break;
      const last = values[values.length - 1];
      const next = last.archiveTimestamp;
      if (!next || next === before) throw new Error('SHARED_CHANNEL');
      before = next;
    }
  }
  return [...found.values()];
}
async function assertExclusive(guild, group, channel) {
  const others = (await gm.listGroups(guild.id, true)).filter(g => g.status !== 'deleted' && Number(g.id) !== Number(group.id));
  if (others.some(g => gm.channelBelongs(g, channel.id))) throw new Error('SHARED_CHANNEL');
  // Threads inherit overwrites from their parent. Only a dedicated, linked parent is safe.
  if (channel.type === ChannelType.GuildText && channel.threads) {
    const threads = await threadChoices(channel);
    if (threads.some(thread => thread.id !== group.thread_id)) throw new Error('SHARED_CHANNEL');
  }
}
async function groupChannels(guild, group, scope) {
  choose(scope, ['text', 'voice', 'both']);
  const channels = [];
  if (scope !== 'voice') {
    const text = await channelById(guild, group.text_channel_id);
    if (!text || text.type !== ChannelType.GuildText || !text.permissionOverwrites) throw new Error('CHANNEL_NOT_FOUND');
    if (group.thread_id) {
      const thread = await channelById(guild, group.thread_id);
      if (!thread?.isThread?.() || thread.parentId !== text.id) throw new Error('INVALID_THREAD');
    }
    await assertExclusive(guild, group, text);
    channels.push(text);
  }
  if (scope !== 'text') {
    const voice = await channelById(guild, group.voice_channel_id);
    if (!voice || voice.type !== ChannelType.GuildVoice || !voice.permissionOverwrites) throw new Error('CHANNEL_NOT_FOUND');
    await assertExclusive(guild, group, voice);
    channels.push(voice);
  }
  const me = guild.members.me || await guild.members.fetchMe();
  for (const channel of channels) {
    if (!channel.permissionsFor(me)?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ManageRoles])) throw new Error('MISSING_PERMISSIONS');
  }
  return channels;
}
function protectedIds(context, settings, group) {
  const ids = new Set([String(group.owner_id), ...group.managerIds, ...settings.systemUsers, String(context.guild.ownerId), String(context.client.user.id)]);
  for (const member of context.guild.members.cache.values()) if (gm.canManageSystem(context.client, settings, member)) ids.add(member.id);
  return ids;
}
async function targetMember(context, settings, group, userId, restrictive = false) {
  const member = await context.guild.members.fetch(String(userId)).catch(() => null);
  if (!member) throw new Error('MEMBER_NOT_FOUND');
  if (member.user.bot || (restrictive && (member.permissions?.has(PermissionsBitField.Flags.Administrator) || protectedIds(context, settings, group).has(member.id) || gm.canManageGroup(context.client, settings, group, member)))) throw new Error('TARGET_PROTECTED');
  return member;
}
// Restore only flags touched by this operation if Discord or persistence rejects a later step.
async function applyChannelEdits(edits, reason, complete = async () => {}) {
  const applied = [];
  try {
    for (const edit of edits) {
      const old = edit.channel.permissionOverwrites.cache.get(edit.id);
      const snapshot = Object.fromEntries(Object.keys(edit.patch).map(flag => [flag, old?.allow.has(PermissionsBitField.Flags[flag]) ? true : old?.deny.has(PermissionsBitField.Flags[flag]) ? false : null]));
      const type = old?.type ?? (edit.channel.guild.roles.cache.has(edit.id) || edit.id === edit.channel.guild.id ? OverwriteType.Role : OverwriteType.Member);
      await edit.channel.permissionOverwrites.edit(edit.id, edit.patch, { reason, type });
      applied.push({ ...edit, type, snapshot, existed: Boolean(old) });
    }
    return await complete();
  } catch (error) {
    let rollbackFailed = false;
    for (const edit of applied.reverse()) {
      try {
        await edit.channel.permissionOverwrites.edit(edit.id, edit.snapshot, { reason: 'Rollback incomplete group control', type: edit.type });
        const current = edit.channel.permissionOverwrites.cache.get(edit.id);
        if (!edit.existed && current && current.allow.bitfield === 0n && current.deny.bitfield === 0n) await edit.channel.permissionOverwrites.delete(edit.id, 'Remove empty rollback overwrite');
      } catch { rollbackFailed = true; }
    }
    if (rollbackFailed) error.groupRollbackFailed = true;
    throw error;
  }
}
async function applyGroupControl(interaction, action, scope, groupId) {
  choose(action, [...CONTROL_ACTIONS]);
  choose(scope, ['text', 'voice']);
  return groupOperation(`group:${interaction.guild.id}:${groupId}`, async () => {
    const { group, settings } = await currentManager(interaction, groupId, ['mute', 'unmute'].includes(action));
    const channels = await groupChannels(interaction.guild, group, scope);
    const channel = channels[0];
    const role = group.role_id && await interaction.guild.roles.fetch(group.role_id).catch(() => null);
    if (!role || role.id === interaction.guild.id || role.managed) throw new Error('INVALID_ROLE');
    const flags = ['hide', 'show'].includes(action) ? ['ViewChannel'] : scope === 'voice' ? (['lock', 'unlock'].includes(action) ? ['Connect'] : ['Speak', 'Stream', 'UseVAD']) : (['lock', 'unlock'].includes(action) ? ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads'] : ['SendMessages', 'SendMessagesInThreads', 'AddReactions']);
    const enabled = ['unlock', 'show', 'unmute'].includes(action);
    // Fresh member data is required even if the owner/managers are not in the gateway cache.
    await Promise.all([...new Set([group.owner_id, ...group.managerIds, ...group.memberIds, ...settings.systemUsers])].map(id => interaction.guild.members.fetch(id).catch(error => {
      if (id === group.owner_id || group.managerIds.includes(id)) throw error;
      return null;
    })));
    const protectedUsers = protectedIds(interaction, settings, group);
    const targetIds = new Set([interaction.guild.id, role.id, ...group.memberIds]);
    for (const overwrite of channel.permissionOverwrites.cache.values()) {
      if (overwrite.type === OverwriteType.Member || (overwrite.type === OverwriteType.Role && !settings.systemRoles.includes(overwrite.id) && flags.some(flag => overwrite.allow.has(PermissionsBitField.Flags[flag])))) targetIds.add(overwrite.id);
    }
    const edits = [];
    for (const id of targetIds) {
      if (protectedUsers.has(id)) continue;
      // Do not resurrect an explicit member deny or unblock a blocked user on unlock/show.
      const existing = channel.permissionOverwrites.cache.get(id);
      if (enabled && existing?.type === OverwriteType.Member && !group.memberIds.includes(id) && !flags.some(flag => existing.allow.has(PermissionsBitField.Flags[flag]))) continue;
      // Unlock/show preserve a private group: @everyone and blocked members remain denied.
      const value = id === interaction.guild.id || group.blockedIds.includes(id) ? false : enabled;
      edits.push({ channel, id, patch: Object.fromEntries(flags.map(flag => [flag, value])) });
    }
    const protectionEdits = [];
    for (const id of protectedUsers) {
      if (interaction.guild.members.cache.has(id)) protectionEdits.push({ channel, id, patch: Object.fromEntries(flags.map(flag => [flag, true])) });
    }
    // Install access exceptions before denying @everyone, otherwise a non-admin bot can lock itself out.
    edits.unshift(...protectionEdits);
    await applyChannelEdits(edits, `Group ${scope} ${action} by ${interaction.user.id}`, () => gm.audit(interaction.guild.id, interaction.user.id, group.id, `control_${action}`, { scope, channelId: channel.id }));
    return `تم ${action} لقناة ${scope} الخاصة بالقروب فقط.`;
  });
}
function controlGroupPayload(guild, groupId) {
  const c = baseContainer(guild, 'التحكم بالقروب', 'التحكم متاح لمالك القروب ومسؤوليه. الكتم والطرد والصلاحيات تتطلب الصلاحيات الإضافية.\nاكتب الأوامر مباشرة في قناة القروب دون بادئة.\n`تحكم` • `إضافة @عضو` • `إزالة @عضو` • `منع @عضو` • `سماح @عضو`\n`قروبي` • `أعضاء` • `مسؤول @عضو` (للمالك أو مسؤول النظام)');
  const id = Number(groupId);
  const controls = [
    ['lock', 'text', 'قفل النص'], ['unlock', 'text', 'فتح النص'], ['hide', 'text', 'إخفاء النص'], ['show', 'text', 'إظهار النص'], ['mute', 'text', 'كتم النص'],
    ['unmute', 'text', 'فك كتم النص'], ['lock', 'voice', 'قفل الفويس'], ['unlock', 'voice', 'فتح الفويس'], ['hide', 'voice', 'إخفاء الفويس'], ['show', 'voice', 'إظهار الفويس'],
    ['mute', 'voice', 'كتم الفويس'], ['unmute', 'voice', 'فك كتم الفويس'], ['kick', 'voice', 'فصل من الفويس'], ['allow', 'both', 'سماح'], ['deny', 'both', 'منع'],
    ['rename', 'both', 'تغيير الاسم'], ['limit', 'voice', 'حد الفويس'], ['permission', 'both', 'الصلاحيات']
  ];
  for (let offset = 0; offset < controls.length; offset += 5) c.addActionRowComponents(new ActionRowBuilder().addComponents(controls.slice(offset, offset + 5).map(([action, scope, label]) => button(`groups_control:${action}:${id}:${scope}`, label, action === 'deny' || action === 'kick' ? ButtonStyle.Danger : ButtonStyle.Secondary))));
  c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('عرض تفاصيل القروب.')).setButtonAccessory(button(`groups_member:info:${id}`, 'قروبي')));
  return componentsV2Payload(c);
}
function flowSelect(guild, flow, title, description, options) { return selectPayload(guild, title, description, flowId(flow), options); }
function entitySelect(guild, flow, title, description, menu) {
  const c = baseContainer(guild, title, description);
  c.addActionRowComponents(new ActionRowBuilder().addComponents(menu.setCustomId(flowId(flow)).setMinValues(1).setMaxValues(1)));
  c.addActionRowComponents(new ActionRowBuilder().addComponents(button(`groups_flow:${flow.token}:cancel`, 'إلغاء')));
  return componentsV2Payload(c);
}
function scopePayload(guild, flow) {
  return flowSelect(guild, flow, 'روم القروب', 'اختر قناة القروب فقط.', [{ label: 'النص أو أب الثريد', value: 'text' }, { label: 'الصوت', value: 'voice' }, { label: 'النص والفويس', value: 'both' }]);
}
function confirmFlowPayload(guild, flow, description) {
  const c = baseContainer(guild, 'تأكيد عملية القروب', description);
  c.addActionRowComponents(new ActionRowBuilder().addComponents(button(flowId(flow), 'تأكيد', ButtonStyle.Success), button(`groups_flow:${flow.token}:cancel`, 'إلغاء')));
  return componentsV2Payload(c);
}
async function showRenameModal(interaction, groupId, scope) {
  choose(scope, ['name', 'text', 'voice']);
  const { group } = await currentManager(interaction, groupId);
  const flow = newFlow(interaction.guild.id, interaction.user.id, 'rename', group.id);
  flow.scope = scope; flow.step = 'submit';
  const modal = new ModalBuilder().setCustomId(flowId(flow)).setTitle('تغيير اسم روم القروب');
  modal.addLabelComponents(new LabelBuilder().setLabel('الاسم الجديد').setTextInputComponent(new TextInputBuilder().setCustomId('value').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80).setValue(safe(group.name, 80))));
  return interaction.showModal(modal);
}
async function renameGroupResources(context, group, scope, rawName) {
  const value = String(rawName || '').trim();
  if (!value || value.length > 80 || /[\u0000-\u001f]/.test(value)) throw new Error('NAME_REQUIRED');
  const channels = [];
  if (scope === 'name') {
    if ((await gm.listGroups(context.guild.id)).some(g => g.id !== group.id && g.name === value)) throw new Error('NAME_EXISTS');
    const linked = await groupChannels(context.guild, group, 'both');
    const chat = group.thread_id ? await channelById(context.guild, group.thread_id) : linked[0];
    channels.push(chat, linked[1]);
  } else {
    const linked = await groupChannels(context.guild, group, scope);
    channels.push(scope === 'text' && group.thread_id ? await channelById(context.guild, group.thread_id) : linked[0]);
  }
  const me = context.guild.members.me || await context.guild.members.fetchMe();
  for (const channel of channels) if (!channel?.permissionsFor(me)?.has(channel.isThread?.() ? PermissionsBitField.Flags.ManageThreads : PermissionsBitField.Flags.ManageChannels)) throw new Error('MISSING_PERMISSIONS');
  const changed = [];
  try {
    for (const channel of channels) {
      const oldName = channel.name;
      await channel.setName(value, `Group rename by ${context.user?.id || context.author.id}`);
      changed.push({ channel, oldName });
    }
    if (scope === 'name') await gm.updateGroup(context.guild.id, group.id, { name: value, updated_at: Date.now() }, context.user?.id || context.author.id);
    await gm.audit(context.guild.id, context.user?.id || context.author.id, group.id, 'control_rename', { scope, name: value });
  } catch (error) {
    for (const item of changed.reverse()) await item.channel.setName(item.oldName, 'Rollback group rename').catch(() => { error.groupRollbackFailed = true; });
    throw error;
  }
  invalidateGroupCaches(context.guild.id);
}
async function applyUserControl(interaction, flow, userId) {
  return groupOperation(`group:${interaction.guild.id}:${flow.groupId}`, async () => {
    const { settings, group } = await currentManager(interaction, flow.groupId, true);
    const target = await targetMember(interaction, settings, group, userId, flow.action !== 'allow');
    if (flow.action === 'kick') {
      const [voice] = await groupChannels(interaction.guild, group, 'voice');
      if (target.voice.channelId !== voice.id) throw new Error('NOT_IN_GROUP_VOICE');
      const me = interaction.guild.members.me || await interaction.guild.members.fetchMe();
      if (!voice.permissionsFor(me)?.has(PermissionsBitField.Flags.MoveMembers)) throw new Error('MISSING_PERMISSIONS');
      await target.voice.disconnect(`Group voice kick by ${interaction.user.id}`);
      await gm.audit(interaction.guild.id, interaction.user.id, group.id, 'control_kick', { userId, channelId: voice.id });
      return 'تم فصل العضو من روم القروب فقط (ليس طرداً من السيرفر).';
    }
    choose(flow.action, ['allow', 'deny']);
    if (flow.action === 'deny' && (String(group.owner_id) === String(target.id) || group.managerIds.includes(String(target.id)))) {
      throw new Error('TARGET_PROTECTED');
    }
    if (flow.action === 'allow' && flow.scope === 'both') {
      const linkedGroups = await gm.listGroups(interaction.guild.id);
      if (linkedGroups.some(item => item.id !== group.id && (String(item.owner_id) === String(target.id) || item.memberIds.includes(String(target.id)) || item.managerIds.includes(String(target.id)))) throw new Error('USER_ALREADY_IN_GROUP');
    }
    const channels = await groupChannels(interaction.guild, group, flow.scope);
    const allowed = flow.action === 'allow';
    const thread = flow.scope !== 'voice' && group.thread_id ? await channelById(interaction.guild, group.thread_id) : null;
    if (thread?.archived && allowed) throw new Error('THREAD_ARCHIVED');
    if (allowed && flow.scope === 'both' && !group.memberIds.includes(userId) && new Set([String(group.owner_id), ...group.memberIds.map(String)]).size >= settings.maxMembers) throw new Error('GROUP_FULL');
    let wasThreadMember = false;
    let changedThread = false;
    let groupRole = null, hadGroupRole = false, changedGroupRole = false;
    const edits = channels.map(channel => ({ channel, id: target.id, patch: Object.fromEntries((channel.type === ChannelType.GuildVoice ? VOICE_ACCESS : TEXT_ACCESS).map(flag => [flag, allowed])) }));
    try {
      await applyChannelEdits(edits, `Group ${flow.action} by ${interaction.user.id}`, async () => {
        if (thread) {
          wasThreadMember = Boolean(await thread.members.fetch(target.id).catch(() => null));
          if (allowed !== wasThreadMember) {
            await (allowed ? thread.members.add(target.id) : thread.members.remove(target.id));
            changedThread = true;
          }
        }
        if (flow.scope === 'both') {
          if (group.role_id) {
            groupRole = interaction.guild.roles.cache.get(group.role_id) || await interaction.guild.roles.fetch(group.role_id).catch(() => null);
            if (!groupRole) throw new Error('GROUP_ROLE_NOT_FOUND');
            hadGroupRole = target.roles.cache.has(groupRole.id);
            if (allowed && !hadGroupRole) { await target.roles.add(groupRole, 'Group membership allowed'); changedGroupRole = true; }
            if (!allowed && hadGroupRole) { await target.roles.remove(groupRole, 'Group membership denied'); changedGroupRole = true; }
          }
          await dbManager.transaction(async tx => {
            const row = await tx.get('SELECT * FROM managed_groups WHERE guild_id = ? AND id = ?', [interaction.guild.id, group.id]);
            if (!row || row.status !== 'active') throw new Error('GROUP_NOT_FOUND');
            const members = JSON.parse(row.member_ids_json || '[]');
            const blocked = JSON.parse(row.blocked_ids_json || '[]');
            const managers = JSON.parse(row.manager_ids_json || '[]');
            if (!allowed && (row.owner_id === target.id || managers.includes(target.id))) throw new Error('TARGET_PROTECTED');
            if (allowed && !members.includes(target.id) && new Set([String(row.owner_id), ...members.map(String)]).size >= settings.maxMembers) throw new Error('GROUP_FULL');
            const now = Date.now();
            await tx.run('UPDATE managed_groups SET member_ids_json = ?, blocked_ids_json = ?, updated_at = ? WHERE guild_id = ? AND id = ?', [JSON.stringify(allowed ? [...new Set([...members, target.id])] : members.filter(id => id !== target.id)), JSON.stringify(allowed ? blocked.filter(id => id !== target.id) : [...new Set([...blocked, target.id])]), now, interaction.guild.id, group.id]);
            await tx.run('INSERT INTO group_audit_log(guild_id,group_id,actor_id,action,details_json,created_at) VALUES(?,?,?,?,?,?)', [interaction.guild.id, group.id, interaction.user.id, `control_${flow.action}`, JSON.stringify({ scope: flow.scope, userId: target.id }), now]);
          }, 'group-access-control');
        } else await gm.audit(interaction.guild.id, interaction.user.id, group.id, `control_${flow.action}`, { scope: flow.scope, userId: target.id });
      });
    } catch (error) {
      if (changedThread) await (wasThreadMember ? thread.members.add(target.id) : thread.members.remove(target.id)).catch(() => { error.groupRollbackFailed = true; });
      if (changedGroupRole && groupRole) await (hadGroupRole ? target.roles.add(groupRole, 'Rollback group access') : target.roles.remove(groupRole, 'Rollback group access')).catch(() => { error.groupRollbackFailed = true; });
      throw error;
    }
    invalidateGroupCaches(interaction.guild.id);
    return `تم ${flow.action} للعضو في ${flow.scope} فقط؛ لم تتغير صلاحيات رتب السيرفر.`;
  });
}
async function applyPermission(interaction, flow) {
  return groupOperation(`group:${interaction.guild.id}:${flow.groupId}`, async () => {
    const { settings, group } = await currentManager(interaction, flow.groupId, true);
    choose(flow.permission, SAFE_PERMISSIONS[flow.scope] || []);
    choose(flow.mode, ['allow', 'deny', 'inherit']);
    let targetId;
    if (flow.targetKind === 'role') {
      const role = group.role_id && await interaction.guild.roles.fetch(group.role_id).catch(() => null);
      if (!role || role.managed || role.id === interaction.guild.id) throw new Error('INVALID_ROLE');
      targetId = role.id;
    } else if (flow.targetKind === 'member') targetId = (await targetMember(interaction, settings, group, flow.targetId, flow.mode !== 'allow')).id;
    else throw new Error('INVALID_SELECTION');
    const channels = await groupChannels(interaction.guild, group, flow.scope);
    const value = flow.mode === 'inherit' ? null : flow.mode === 'allow';
    const edits = channels.map(channel => ({ channel, id: targetId, patch: { [flow.permission]: value } }));
    if (flow.targetKind === 'role' && value !== true) {
      await Promise.all([group.owner_id, ...group.managerIds].map(id => interaction.guild.members.fetch(id)));
      for (const id of protectedIds(interaction, settings, group)) if (interaction.guild.members.cache.has(id)) {
        for (const channel of channels) edits.unshift({ channel, id, patch: { [flow.permission]: true } });
      }
    }
    const thread = flow.targetKind === 'member' && flow.scope !== 'voice' && flow.permission === 'ViewChannel' && value !== null && group.thread_id ? await channelById(interaction.guild, group.thread_id) : null;
    if (thread?.archived && value === true) throw new Error('THREAD_ARCHIVED');
    let wasThreadMember = false, changedThread = false;
    try {
      await applyChannelEdits(edits, `Group permission by ${interaction.user.id}`, async () => {
        if (thread) {
          wasThreadMember = Boolean(await thread.members.fetch(targetId).catch(() => null));
          if (value !== wasThreadMember) {
            await (value ? thread.members.add(targetId) : thread.members.remove(targetId));
            changedThread = true;
          }
        }
        await gm.audit(interaction.guild.id, interaction.user.id, group.id, 'control_permission', { scope: flow.scope, targetId, permission: flow.permission, mode: flow.mode });
      });
    } catch (error) {
      if (changedThread) await (wasThreadMember ? thread.members.add(targetId) : thread.members.remove(targetId)).catch(() => { error.groupRollbackFailed = true; });
      throw error;
    }
    return `تم ${flow.mode} لـ ${flow.permission} على قناة القروب فقط.`;
  });
}
function permissionOptions(flow) { return SAFE_PERMISSIONS[flow.scope].map(flag => ({ label: flag, value: flag })); }
async function validateImport(guild, flow, settings, includeMembers = false) {
  const groups = (await gm.listGroups(guild.id, true)).filter(g => g.status !== 'deleted');
  const linkedIds = [flow.textId, flow.threadId, flow.voiceId].filter(Boolean);
  if (groups.some(g => (flow.roleId && g.role_id === flow.roleId) || (flow.ownerId && [g.owner_id, ...g.memberIds, ...g.managerIds].includes(flow.ownerId)) || linkedIds.some(id => gm.channelBelongs(g, id)))) throw new Error('ASSET_LINKED');
  const role = flow.roleId ? await guild.roles.fetch(flow.roleId).catch(() => null) : null;
  if (flow.roleId && (!role || role.id === guild.id || role.managed || !role.editable || [settings.leaderRoleId, settings.managerRoleId, ...settings.systemRoles].includes(role.id) || role.permissions.has([PermissionsBitField.Flags.Administrator], false) || role.permissions.any([PermissionsBitField.Flags.ManageRoles, PermissionsBitField.Flags.ManageGuild, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ModerateMembers, PermissionsBitField.Flags.KickMembers, PermissionsBitField.Flags.BanMembers]))) throw new Error('INVALID_ROLE');
  const owner = flow.ownerId ? await guild.members.fetch(flow.ownerId).catch(() => null) : null;
  if (flow.ownerId && (!owner || owner.user.bot || !owner.roles.cache.has(flow.roleId))) throw new Error('MEMBER_NOT_FOUND');
  let text, thread, voice;
  if (flow.textId) {
    text = await channelById(guild, flow.textId);
    if (text?.type !== ChannelType.GuildText) throw new Error('CHANNEL_NOT_FOUND');
  }
  if (flow.threadId) {
    thread = await channelById(guild, flow.threadId);
    if (!thread?.isThread?.() || thread.parentId !== flow.textId) throw new Error('INVALID_THREAD');
    if (thread.archived) throw new Error('THREAD_ARCHIVED');
  }
  if (flow.voiceId) {
    voice = await channelById(guild, flow.voiceId);
    if (voice?.type !== ChannelType.GuildVoice || voice.id === settings.musicChannelId) throw new Error('CHANNEL_NOT_FOUND');
  }
  let members = [];
  if (includeMembers) {
    // Fetch the full role membership, not just the gateway cache. Import never grants/removes roles.
    await guild.members.fetch();
    members = [...role.members.values()].map(member => member.id);
    if (!members.includes(owner.id)) throw new Error('MEMBER_NOT_FOUND');
    if (members.length > settings.maxMembers) throw new Error('GROUP_FULL');
    if (groups.some(g => members.some(id => [g.owner_id, ...g.memberIds, ...g.managerIds].includes(id)))) throw new Error('ASSET_LINKED');
    if (thread) {
      for (let offset = 0; offset < members.length; offset += 5) {
        const batch = members.slice(offset, offset + 5);
        const memberships = await Promise.all(batch.map(id => thread.members.fetch(id).catch(() => null)));
        if (memberships.some((membership, index) => !membership && batch[index] === owner.id)) throw new Error('OWNER_NOT_IN_THREAD');
        if (memberships.some(membership => !membership)) throw new Error('THREAD_MEMBERS_MISMATCH');
      }
    }
    await groupChannels(guild, { id: null, text_channel_id: text.id, thread_id: thread?.id || null, voice_channel_id: voice.id }, 'both');
  }
  return { role, owner, text, thread, voice, members };
}
function importThreadPayload(guild, flow) {
  const offset = (flow.page || 0) * 25;
  const options = flow.threads.slice(offset, offset + 25).map(thread => ({ label: safe(thread.name, 95) || thread.id, value: thread.id, description: thread.archived ? 'ثريد مؤرشف موجود' : 'ثريد نشط موجود' }));
  const payload = flowSelect(guild, flow, 'Import: existing thread', `صفحة ${(flow.page || 0) + 1} / ${Math.ceil(flow.threads.length / 25)}. اختر ثريداً تابعاً للقناة المختارة.`, options);
  const row = new ActionRowBuilder();
  if (offset > 0) row.addComponents(button(`groups_flow:${flow.token}:prev`, 'السابق'));
  if (offset + 25 < flow.threads.length) row.addComponents(button(`groups_flow:${flow.token}:next`, 'التالي'));
  row.addComponents(button(`groups_flow:${flow.token}:cancel`, 'إلغاء'));
  payload.components[0].addActionRowComponents(row);
  return payload;
}
async function saveImportedGroup(interaction, flow) {
  return groupOperation(`import:${interaction.guild.id}`, async () => {
    const settings = await currentSystem(interaction);
    const { role, owner, text, thread, voice, members } = await validateImport(interaction.guild, flow, settings, true);
    const groupName = safe(thread?.name || role.name.replace(/^Group[・\s]+/, '') || text.name, 80).trim();
    if (!groupName) throw new Error('NAME_REQUIRED');
    await gm.schema();
    const groupId = await dbManager.transaction(async tx => {
      const existing = await tx.all("SELECT * FROM managed_groups WHERE guild_id = ? AND status != 'deleted'", [interaction.guild.id]);
      const assetIds = [text.id, thread?.id, voice.id].filter(Boolean);
      for (const row of existing) {
        let priorMembers = [], priorManagers = [];
        try { priorMembers = JSON.parse(row.member_ids_json || '[]'); priorManagers = JSON.parse(row.manager_ids_json || '[]'); } catch { throw new Error('ASSET_LINKED'); }
        if (row.role_id === role.id || assetIds.some(id => [row.text_channel_id, row.thread_id, row.voice_channel_id].includes(id)) || members.some(id => [row.owner_id, ...priorMembers, ...priorManagers].includes(id))) throw new Error('ASSET_LINKED');
        if (row.status === 'active' && row.name === groupName) throw new Error('NAME_EXISTS');
      }
      const now = Date.now();
      const result = await tx.run(`INSERT INTO managed_groups(guild_id,name,description,owner_id,manager_ids_json,member_ids_json,blocked_ids_json,role_id,text_channel_id,thread_id,voice_channel_id,color,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [interaction.guild.id, groupName, '', owner.id, '[]', JSON.stringify(members), '[]', role.id, text.id, thread?.id || null, voice.id, role.hexColor || '#5865F2', now, now]);
      const importedId = result.id ?? result.lastID;
      if (!Number.isSafeInteger(importedId) || importedId <= 0) throw new Error('GROUP_NOT_FOUND');
      await tx.run('INSERT INTO group_audit_log(guild_id,group_id,actor_id,action,details_json,created_at) VALUES(?,?,?,?,?,?)', [interaction.guild.id, importedId, interaction.user.id, 'group_import', JSON.stringify({ roleId: role.id, ownerId: owner.id, textId: text.id, threadId: thread?.id || null, voiceId: voice.id, members: members.length }), now]);
      return importedId;
    }, 'group-import');
    invalidateGroupCaches(interaction.guild.id);
    return `تم استيراد **${safe(groupName)}** (#${groupId}) وربط ${members.length} عضواً. لم تُنشأ أو تُحذف أي قناة/رتبة ولم تتغير صلاحيات العناصر الموجودة.`;
  });
}
async function advanceImport(interaction, flow, settings) {
  const value = flow.step === 'confirm' ? null : oneValue(interaction);
  if (flow.step === 'role') {
    flow.roleId = value; await validateImport(interaction.guild, flow, settings);
    flow.step = 'owner';
    return entitySelect(interaction.guild, flow, 'استيراد : المالك', 'اختر عضواً موجوداً يحمل رتبة القروب المختارة وغير مرتبط بقروب آخر.', new UserSelectMenuBuilder().setPlaceholder('مالك القروب الموجود'));
  }
  if (flow.step === 'owner') {
    flow.ownerId = value; await validateImport(interaction.guild, flow, settings);
    flow.step = 'text';
    return entitySelect(interaction.guild, flow, 'استيراد : الشات النصي', 'اختر قناة نصية موجودة ومخصصة لهذا القروب، أو أب ثريده.', new ChannelSelectMenuBuilder().setChannelTypes(ChannelType.GuildText).setPlaceholder('شات القروب النصي الموجود'));
  }
  if (flow.step === 'text') {
    flow.textId = value; await validateImport(interaction.guild, flow, settings);
    flow.step = 'chat';
    return flowSelect(interaction.guild, flow, 'استيراد : نمط الشات', 'استيراد القناة نفسها أم ثريد موجود تحتها؟ لا يتم إنشاء عناصر جديدة.', [{ label: 'استخدام الشات النصي بدون ثريد', value: 'channel' }, { label: 'ربط ثريد موجود', value: 'thread' }]);
  }
  if (flow.step === 'chat') {
    choose(value, ['channel', 'thread']);
    const text = await channelById(interaction.guild, flow.textId);
    const threads = await threadChoices(text);
    if (value === 'thread') {
      const groups = (await gm.listGroups(interaction.guild.id, true)).filter(g => g.status !== 'deleted');
      flow.threads = threads.filter(t => !groups.some(g => gm.channelBelongs(g, t.id))).map(t => ({ id: t.id, name: t.name, archived: t.archived }));
      if (!flow.threads.length) throw new Error('INVALID_THREAD');
      flow.step = 'thread'; flow.page = 0;
      return importThreadPayload(interaction.guild, flow);
    }
    if (threads.length) throw new Error('SHARED_CHANNEL');
    flow.threadId = null; flow.step = 'voice';
    return entitySelect(interaction.guild, flow, 'استيراد : روم الفويس', 'اختر روم القروب الصوتي الموجود.', new ChannelSelectMenuBuilder().setChannelTypes(ChannelType.GuildVoice).setPlaceholder('روم فويس القروب الموجود'));
  }
  if (flow.step === 'thread') {
    if (!flow.threads.slice((flow.page || 0) * 25, ((flow.page || 0) + 1) * 25).some(t => t.id === value)) throw new Error('INVALID_SELECTION');
    flow.threadId = value; await validateImport(interaction.guild, flow, settings);
    const parent = await channelById(interaction.guild, flow.textId);
    if ((await threadChoices(parent)).some(t => t.id !== value)) throw new Error('SHARED_CHANNEL');
    flow.step = 'voice';
    return entitySelect(interaction.guild, flow, 'استيراد : روم الفويس', 'اختر روم القروب الصوتي الموجود.', new ChannelSelectMenuBuilder().setChannelTypes(ChannelType.GuildVoice).setPlaceholder('روم فويس القروب الموجود'));
  }
  if (flow.step === 'voice') {
    flow.voiceId = value;
    const assets = await validateImport(interaction.guild, flow, settings, true);
    flow.step = 'confirm';
    return confirmFlowPayload(interaction.guild, flow, `Role: <@&${assets.role.id}>\nOwner: <@${assets.owner.id}>\nText: <#${assets.text.id}>\nThread: ${assets.thread ? `<#${assets.thread.id}>` : 'لا يوجد'}\nVoice: <#${assets.voice.id}>\nMembers: ${assets.members.length}\nسيتم الربط فقط دون تعديل العناصر الموجودة.`);
  }
  if (flow.step === 'confirm') {
    if (!interaction.isButton?.()) throw new Error('INVALID_SELECTION');
    const result = await saveImportedGroup(interaction, flow);
    forgetFlow(flow);
    return componentsV2Payload(baseContainer(interaction.guild, 'تم استيراد القروب', result));
  }
  throw new Error('INVALID_SELECTION');
}
async function advancePermission(interaction, flow) {
  if (flow.step === 'scope') {
    flow.scope = choose(oneValue(interaction), ['text', 'voice', 'both']); flow.step = 'target';
    return flowSelect(interaction.guild, flow, 'هدف الصلاحية', 'الصلاحية على قناة القروب فقط؛ لا يمكن اختيار رتب إدارية أو صلاحيات سيرفر.', [{ label: 'رول القروب', value: 'role' }, { label: 'عضو واحد', value: 'member' }]);
  }
  if (flow.step === 'target') {
    flow.targetKind = choose(oneValue(interaction), ['role', 'member']);
    if (flow.targetKind === 'member') {
      flow.step = 'member';
      return entitySelect(interaction.guild, flow, 'عضو الصلاحية', 'اختر عضواً موجوداً. لا يمكن تقييد المالك أو المسؤولين.', new UserSelectMenuBuilder().setPlaceholder('اختر عضوًا'));
    }
    flow.step = 'flag';
    return flowSelect(interaction.guild, flow, 'صلاحية الروم', 'اختر صلاحية آمنة واحدة فقط.', permissionOptions(flow));
  }
  if (flow.step === 'member') {
    flow.targetId = oneValue(interaction);
    const { settings, group } = await currentManager(interaction, flow.groupId, true);
    await targetMember(interaction, settings, group, flow.targetId);
    flow.step = 'flag';
    return flowSelect(interaction.guild, flow, 'صلاحية الروم', 'اختر صلاحية آمنة واحدة فقط.', permissionOptions(flow));
  }
  if (flow.step === 'flag') {
    flow.permission = choose(oneValue(interaction), SAFE_PERMISSIONS[flow.scope]); flow.step = 'mode';
    return flowSelect(interaction.guild, flow, 'نوع الصلاحية', 'سماح = إعطاء، منع = حظر، توريث = إزالة الاستثناء فقط.', [{ label: 'سماح', value: 'allow' }, { label: 'منع', value: 'deny' }, { label: 'توريث / إزالة الاستثناء', value: 'inherit' }]);
  }
  if (flow.step === 'mode') {
    flow.mode = choose(oneValue(interaction), ['allow', 'deny', 'inherit']); flow.step = 'confirm';
    return confirmFlowPayload(interaction.guild, flow, `Scope: ${flow.scope}\nTarget: ${flow.targetKind === 'role' ? 'رول القروب' : `<@${flow.targetId}>`}\nPermission: ${flow.permission}\nMode: ${flow.mode}\nلن تتغير أي صلاحيات خارج قناة القروب.`);
  }
  if (flow.step === 'confirm') {
    if (!interaction.isButton?.()) throw new Error('INVALID_SELECTION');
    const result = await applyPermission(interaction, flow);
    forgetFlow(flow);
    return componentsV2Payload(baseContainer(interaction.guild, 'تم تحديث الصلاحية', result));
  }
  throw new Error('INVALID_SELECTION');
}
async function handleGroupExtensions(interaction) {
  const [prefix, action, groupIdRaw, scope] = String(interaction.customId || '').split(':');
  if (!['groups_control', 'groups_flow'].includes(prefix) && !(prefix === 'groups_admin' && action === 'import')) return false;
  let flow;
  try {
    if (!interaction.guild) throw new Error('NO_PERMISSION');
    if (prefix === 'groups_admin') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await currentSystem(interaction);
      flow = newFlow(interaction.guild.id, interaction.user.id, 'import'); flow.step = 'role';
      return interaction.editReply(entitySelect(interaction.guild, flow, 'استيراد : رول القروب', 'ربط عناصر موجودة فقط. اختر رتبة غير مرتبطة بقروب آخر؛ لن يتم إنشاؤها أو تعديل صلاحياتها.', new RoleSelectMenuBuilder().setPlaceholder('رول القروب الموجود')));
    }
    if (prefix === 'groups_control') {
      const groupId = Number(groupIdRaw);
      if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new Error('GROUP_NOT_FOUND');
      if (action === 'limit') {
        await currentManager(interaction, groupId);
        flow = newFlow(interaction.guild.id, interaction.user.id, 'limit', groupId); flow.step = 'submit';
        const modal = new ModalBuilder().setCustomId(flowId(flow)).setTitle('حد فويس القروب');
        modal.addLabelComponents(new LabelBuilder().setLabel('من 0 إلى 99 (0 = بدون حد)').setTextInputComponent(new TextInputBuilder().setCustomId('value').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2)));
        return interaction.showModal(modal);
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await currentManager(interaction, groupId, ['mute', 'unmute', 'kick', 'allow', 'deny', 'permission'].includes(action));
      if (CONTROL_ACTIONS.has(action)) {
        const result = await applyGroupControl(interaction, action, scope, groupId);
        return interaction.editReply(componentsV2Payload(baseContainer(interaction.guild, 'تم تحديث القروب', result)));
      }
      if (action === 'rename') {
        flow = newFlow(interaction.guild.id, interaction.user.id, 'rename', groupId);
        return interaction.editReply(flowSelect(interaction.guild, flow, 'تغيير الاسم', 'اختر اسم القروب أو إحدى قنواته.', [{ label: 'اسم القروب وأسماء النص والفويس', value: 'name' }, { label: 'اسم النص أو الثريد فقط', value: 'text' }, { label: 'اسم الفويس فقط', value: 'voice' }]));
      }
      if (action === 'permission') {
        flow = newFlow(interaction.guild.id, interaction.user.id, 'permission', groupId);
        return interaction.editReply(scopePayload(interaction.guild, flow));
      }
      choose(action, ['kick', 'allow', 'deny']);
      flow = newFlow(interaction.guild.id, interaction.user.id, 'userControl', groupId); flow.action = action;
      if (action === 'kick') {
        flow.scope = 'voice'; flow.step = 'member';
        return interaction.editReply(entitySelect(interaction.guild, flow, 'فصل عضو من فويس القروب', 'فصل عضو من روم القروب فقط، وليس من السيرفر.', new UserSelectMenuBuilder().setPlaceholder('عضو في فويس القروب')));
      }
      return interaction.editReply(scopePayload(interaction.guild, flow));
    }
    flow = groupFlows.get(action);
    if (!flow || flow.expires <= Date.now() || flow.guildId !== interaction.guild.id) throw new Error('FLOW_EXPIRED');
    if (flow.actorId !== interaction.user.id) throw new Error('FLOW_OWNER');
    const step = groupIdRaw;
    if (step === 'cancel') {
      if (flow.busy) throw new Error('ACTION_BUSY');
      forgetFlow(flow);
      return interaction.update(componentsV2Payload(baseContainer(interaction.guild, 'تم الإلغاء', 'تم إلغاء العملية.')));
    }
    if (flow.busy) throw new Error('ACTION_BUSY');
    if (step === 'submit' && !interaction.isModalSubmit?.()) throw new Error('INVALID_SELECTION');
    if (step === 'confirm' && !interaction.isButton?.()) throw new Error('INVALID_SELECTION');
    if (!['submit', 'confirm', 'prev', 'next'].includes(step) && !interaction.isAnySelectMenu?.()) throw new Error('INVALID_SELECTION');
    const paging = ['prev', 'next'].includes(step) && flow.kind === 'import' && flow.step === 'thread';
    if (step !== flow.step && !paging) throw new Error('FLOW_EXPIRED');
    if (flow.kind === 'rename' && step === 'scope') {
      const selected = choose(oneValue(interaction), ['name', 'text', 'voice']);
      await currentManager(interaction, flow.groupId);
      forgetFlow(flow);
      return showRenameModal(interaction, flow.groupId, selected);
    }
    flow.busy = true;
    if (interaction.isModalSubmit?.()) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    else await interaction.deferUpdate();
    let payload;
    if (flow.kind === 'import') {
      const settings = await currentSystem(interaction);
      if (paging) {
        flow.page = Math.max(0, Math.min(Math.ceil(flow.threads.length / 25) - 1, (flow.page || 0) + (step === 'next' ? 1 : -1)));
        payload = importThreadPayload(interaction.guild, flow);
      } else payload = await advanceImport(interaction, flow, settings);
    } else {
      await currentManager(interaction, flow.groupId, ['permission', 'userControl'].includes(flow.kind));
      if (flow.kind === 'permission') payload = await advancePermission(interaction, flow);
      else if (flow.kind === 'rename' || flow.kind === 'limit') {
        if (!interaction.isModalSubmit?.() || step !== 'submit') throw new Error('INVALID_SELECTION');
        const value = interaction.fields.getTextInputValue('value').trim();
        await groupOperation(`group:${interaction.guild.id}:${flow.groupId}`, async () => {
          const { group } = await currentManager(interaction, flow.groupId);
          if (flow.kind === 'rename') await renameGroupResources(interaction, group, flow.scope, value);
          else {
            if (!/^\d{1,2}$/.test(value) || Number(value) > 99) throw new Error('INVALID_LIMIT');
            const [voice] = await groupChannels(interaction.guild, group, 'voice');
            const me = interaction.guild.members.me || await interaction.guild.members.fetchMe();
            if (!voice.permissionsFor(me)?.has(PermissionsBitField.Flags.ManageChannels)) throw new Error('MISSING_PERMISSIONS');
            await voice.setUserLimit(Number(value), `Group voice limit by ${interaction.user.id}`);
            await gm.audit(interaction.guild.id, interaction.user.id, group.id, 'control_limit', { limit: Number(value), channelId: voice.id });
          }
        });
        forgetFlow(flow);
        payload = componentsV2Payload(baseContainer(interaction.guild, 'تم تحديث القروب', flow.kind === 'limit' ? 'تم تحديث الحد الصوتي لروم القروب.' : 'تم تحديث الاسم.'));
      } else if (flow.kind === 'userControl') {
        if (step === 'scope') {
          flow.scope = choose(oneValue(interaction), ['text', 'voice', 'both']); flow.step = 'member';
          payload = entitySelect(interaction.guild, flow, `Group ${flow.action}`, 'اختر العضو؛ سيُعدل استثناء العضو على قناة القروب فقط.', new UserSelectMenuBuilder().setPlaceholder('اختر عضوًا من السيرفر'));
        } else if (step === 'member') {
          flow.targetId = oneValue(interaction);
          const { settings, group } = await currentManager(interaction, flow.groupId, true);
          await targetMember(interaction, settings, group, flow.targetId, flow.action !== 'allow');
          flow.step = 'confirm';
          payload = confirmFlowPayload(interaction.guild, flow, `Action: ${flow.action}\nScope: ${flow.scope}\nMember: <@${flow.targetId}>`);
        } else if (step === 'confirm' && interaction.isButton?.()) {
          const result = await applyUserControl(interaction, flow, flow.targetId);
          forgetFlow(flow);
          payload = componentsV2Payload(baseContainer(interaction.guild, 'تم تحديث القروب', result));
        } else throw new Error('INVALID_SELECTION');
      } else throw new Error('INVALID_SELECTION');
    }
    return await interaction.editReply({ ...payload, allowedMentions: { parse: [] } });
  } catch (error) {
    if (flow && flow.actorId === interaction.user.id && error.message !== 'ACTION_BUSY') forgetFlow(flow);
    console.error('[groups] scoped action failed:', error);
    const warning = error.groupRollbackFailed ? '\nتنبيه : تعذر التراجع عن بعض التغييرات؛ راجع استثناءات القناة في Discord.' : '';
    const payload = componentsV2Payload(baseContainer(interaction.guild, 'فشلت عملية القروب', groupError(error) + warning));
    if (interaction.deferred && !interaction.replied) return interaction.editReply({ ...payload, allowedMentions: { parse: [] } });
    return reply(interaction, payload);
  } finally { if (flow) flow.busy = false; }
}

module.exports={name,aliases,execute,registerInteractionHandler,handleInternalMessage:dispatchInternalMessage,sendGroupPanel,sendAdminControlPanel,sendMemberControlPanels,sendTopGroupsPanel,buildTopGroupsPayload,selectMemberGroup,buildGroupCommandGuide:groupCommandGuideText,controlPayload,handleInteraction};
