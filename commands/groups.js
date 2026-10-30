const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, LabelBuilder, ModalBuilder, PermissionsBitField, RoleSelectMenuBuilder, StringSelectMenuBuilder, TextDisplayBuilder, SectionBuilder, SeparatorBuilder, ContainerBuilder, ThumbnailBuilder, UserSelectMenuBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
const router = require('../utils/interactionRouter');
const gm = require('../utils/groupManager');
const colorManager = require('../utils/colorManager');
const tempVoice = require('./temp');
const { componentsV2Payload, colorToNumber } = require('../utils/structuredContainer');
const { renderMembers, renderInfo, renderTopGroups, renderMyRank } = require('../utils/groupRenderer');
const { handleInternalMessage, handleMemberPickerInteraction, leaveGroupMember, buildOurMembersPayload } = require('../utils/groupInternal');
const { parseCustomEmoji, parseEmojiId, parseUnicodeEmoji, extractFirstEmoji, resolveIconBuffer, applyRoleIcon } = require('../utils/roleIconUtils');
const name = 'groups';
const aliases = ['group', 'قروب', 'قروبات'];
let registered = false;
const locks = new Set();
const pendingGroupEmoji = new Map();
const orphanCleanupNextAt = new Map();
function safe(s, n=100) { return String(s||'').replace(/[\u0000-\u001f]/g,'').slice(0,n); }
function normalizeGroupAvatar(value) {
  const input = String(value || '').trim();
  if (!input) return null;
  const custom = parseCustomEmoji(input);
  if (custom) return custom.urls[0];
  const emojiId = parseEmojiId(input);
  if (emojiId) return `https://cdn.discordapp.com/emojis/${emojiId}.png`;
  const unicode = extractFirstEmoji(input);
  if (unicode) return parseUnicodeEmoji(unicode);
  let url;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname.toLowerCase())) return null;
  if (!/\.(png|jpe?g|webp|gif)$/i.test(url.pathname)) return null;
  return url.toString();
}
function normalizeGroupEmoji(value) {
  const input = String(value || '').trim();
  if (!input) return null;
  const custom = input.match(/<(a?):([\w~]+):(\d+)>/);
  if (custom) return `<${custom[1]}:${custom[2]}:${custom[3]}>`;
  const emojiId = parseEmojiId(input);
  if (emojiId) return `<:custom:${emojiId}>`;
  return extractFirstEmoji(input) || safe(input, 100);
}
async function applyGroupEmojiRole(guild, group, value) {
  const role = group?.role_id && (guild.roles.cache.get(String(group.role_id)) || await guild.roles.fetch(String(group.role_id)).catch(() => null));
  if (!role) throw new Error('GROUP_ROLE_NOT_FOUND');
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!me?.permissions?.has(PermissionsBitField.Flags.ManageRoles)) throw new Error('MISSING_MANAGE_ROLES');
  if (!role.editable) throw new Error('GROUP_ROLE_NOT_EDITABLE');
  if (!value) { await role.setIcon(null); return; }
  const buffer = await resolveIconBuffer(value);
  if (!buffer) throw new Error('INVALID_EMOJI');
  try { await applyRoleIcon(role, buffer); }
  catch (error) {
    console.error('[groups] failed to apply group role icon:', error?.cause?.message || error?.message || error);
    throw new Error('ROLE_ICON_UPDATE_FAILED');
  }
}
async function applyGroupRoleColor(guild, group, value) {
  const role = group?.role_id && (guild.roles.cache.get(String(group.role_id)) || await guild.roles.fetch(String(group.role_id)).catch(() => null));
  if (!role) throw new Error('GROUP_ROLE_NOT_FOUND');
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!me?.permissions?.has(PermissionsBitField.Flags.ManageRoles)) throw new Error('MISSING_MANAGE_ROLES');
  if (!role.editable) throw new Error('GROUP_ROLE_NOT_EDITABLE');
  try { await role.setColor(value, 'Sync group color'); }
  catch (error) { console.error('[groups] failed to sync group role color:', error?.message || error); throw new Error('ROLE_COLOR_UPDATE_FAILED'); }
}
async function saveGroupSettings(guildId, patch, actorId = null) {
  const updated = await gm.saveSettings(guildId, patch, actorId);
  settingsCache?.delete(String(guildId));
  activityCache?.delete(String(guildId));
  return updated;
}
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
function formatRuleThreshold(metric, value) {
  const threshold = Math.max(0, Number(value) || 0);
  if (metric === 'voice_ms') {
    const hours = Math.floor(threshold / 3600000);
    const minutes = Math.floor((threshold % 3600000) / 60000);
    const seconds = Math.floor((threshold % 60000) / 1000);
    const human = [hours ? `${hours} ساعة` : '', minutes ? `${minutes} دقيقة` : '', seconds ? `${seconds} ثانية` : ''].filter(Boolean).join(' و ') || 'أقل من ثانية';
    return `${human} (${threshold.toLocaleString('en-US')} مللي ثانية)`;
  }
  return `${threshold.toLocaleString('en-US')} ${metric === 'messages' ? 'رسالة' : 'تفاعل'}`;
}
const RULE_METRICS = Object.freeze([
  ['messages', 'الرسائل', 'عدد الرسائل المحتسبة في رومات القروب النصية', 100],
  ['voice_ms', 'الصوت', 'مدة التواجد في الرومات الصوتية بالمللي ثانية', 3600000],
  ['reactions', 'التفاعلات', 'عدد التفاعلات المضافة على الرسائل', 10]
]);
function rulesPayload(guild, rules = []) {
  const byMetric = new Map(rules.map(rule => [String(rule.metric), rule]));
  const c = baseContainer(guild, 'GROUP RULES', 'عرض وتعديل حدود ونقاط الرسائل والصوت والتفاعلات. عند تغيير الحد، يستمر التقدم المتراكم ويؤثر في موعد النقطة التالية.');
  for (const [metric, label, description, defaultThreshold] of RULE_METRICS) {
    const rule = byMetric.get(metric);
    const enabled = Number(rule?.enabled) === 1;
    const configured = Boolean(rule && Number.isInteger(Number(rule.threshold)) && Number(rule.threshold) > 0 && Number.isInteger(Number(rule.points)) && Number(rule.points) > 0);
    const threshold = configured ? Number(rule.threshold) : defaultThreshold;
    const points = configured ? Number(rule.points) : 1;
    c.addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${label}**\n${description}\nالحد : **${configured ? formatRuleThreshold(metric, threshold) : 'غير معين'}** | النقاط : **${configured ? points : 'غير معينة'}** لكل حد مكتمل | الحالة : **${configured && enabled ? 'مفعّل' : 'غير مهيأ'}**`))
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
    logChannelId: 'قناة السجلات غير صالح أو لم يعد موجودًا.',
    topChannelId: 'قناة لوحة الترتيب غير صالح أو لم يعد موجودًا.',
    adminControlChannelId: 'قناة لوحة الإدارة غير صالح أو لم يعد موجودًا.',
    memberControlChannelId: 'قناة لوحة الأعضاء غير صالح أو لم يعد موجودًا.',
    musicChannelId: 'قناة مصدر الموسيقى غير صالح أو لم يعد موجودًا.',
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
    const channel = ({ musicChannelId: 'قناة مصدر الموسيقى', logChannelId: 'قناة السجلات', topChannelId: 'قناة الترتيب', adminControlChannelId: 'قناة تحكم الإدارة', memberControlChannelId: 'قناة تحكم الأعضاء' })[key] || 'القناة المحدد';
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
  const readiness = issues.length ? `الإعداد غير مكتمل (${issues.length}):\n${issues.slice(0, 6).map(setupIssueLabel).join('\n')}${issues.length > 6 ? '\n... استخدم Info لعرض الباقي.' : ''}` : 'الإعداد جاهز لإنشاء القروبات.';
  const summary = `الحالة : ${status}\nجاهزية النظام : ${readiness}\nمسؤولو النظام : ${managerCount} عضو/رتبة\nنمط المحادثة : ${chatMode}\nكاتاقوري النص : ${channelMention(settings.textCategoryId)}\nكاتاقوري الصوت : ${channelMention(settings.voiceCategoryId)}\nقناة الترتيب : ${channelMention(settings.topChannelId)}\nقناة تحكم الإدارة : ${channelMention(settings.adminControlChannelId)}\nقناة تحكم الأعضاء : ${channelMention(settings.memberControlChannelId)}\nالرتبة الرئيسية : ${roleMention(settings.mainRoleId)}\nرتبة المالك : ${roleMention(settings.leaderRoleId)}\nرتبة المسؤول : ${roleMention(settings.managerRoleId)}\nقناة مصدر الموسيقى : ${channelMention(settings.musicChannelId)}\nقناة السجلات : ${channelMention(settings.logChannelId)}\nنطاق احتساب النقاط : ${settings.countAllChannels ? 'كل الرومات' : 'رومات القروبات فقط'}\nالصلاحيات الإضافية : ${settings.extraPermissions ? 'مفعلة' : 'متوقفة'}\nقواعد النقاط : اضغط على زر القواعد للتفاصيل`;
  const sections = [
    ['حالة نظام القروبات', 'تشغيل أو إيقاف نظام القروبات', 'groups_setup:toggle'],
    ['SYSTEM MANAGERS', 'إضافة أو إزالة مسؤولي النظام', 'groups_setup:managers'],
    ['Chat Mode', 'ثريدات أو رومات مستقلة', 'groups_setup:chatmode'],
    ['Text Category', 'تحديد كاتوقري النص أو الثريدات', 'groups_setup:textcat'],
    ['Voice Category', 'تحديد كاتوقري الفويس', 'groups_setup:voicecat'],
    ['Top Channel', 'تحديد القناة الثابتة لإرسال لوحة توب القروبات', 'groups_setup:topchannel'],
    ['Admin Control Channel', 'تحديد القناة الثابتة لإرسال لوحة تحكم الإدارة', 'groups_setup:adminchannel'],
    ['Member Control Channel', 'تحديد القناة الثابتة لإرسال لوحات تحكم أعضاء القروبات', 'groups_setup:memberchannel'],
    ['Main Role', 'الرول الذي تنشأ تحته رولات القروبات تلقائيًا', 'groups_setup:mainrole'],
    ['Music Source', 'تحديد قناة مصدر الميوزك عند إنشاء القروب', 'groups_setup:music'],
    ['Log Channel', 'إرسال لوقات القروبات هنا', 'groups_setup:log'],
    ['Leader Role', 'الرول الذي يأخذه مالك القروب', 'groups_setup:leaderrole'],
    ['Manager Role', 'الرول الذي يأخذه مسؤول القروب', 'groups_setup:managerrole'],
    ['Points Scope', 'كل الرومات أو رومات القروبات', 'groups_setup:scope'],
    ['الصلاحيات الإضافية', 'تفعيل المسح وأدوات الإدارة', 'groups_setup:extra'],
    ['Point Rules', 'تخصيص قواعد نقاط القروبات', 'groups_setup:rules']
  ];
  const make = (title, items, includeSummary, includeTools = false) => {
    const c = includeSummary
      ? baseContainer(guild, title, summary)
      : new ContainerBuilder().setAccentColor(colorToNumber(colorManager.getColor?.() || '#5865F2'));
    for (const [label, desc, id] of items) c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${label}**\n${desc}`)).setButtonAccessory(button(id, 'فتح')));
    if (includeTools) {
      c.addSeparatorComponents(new SeparatorBuilder());
      c.addTextDisplayComponents(new TextDisplayBuilder().setContent('### TOOLS\nأدوات سريعة لإدارة الإعدادات.'));
      c.addActionRowComponents(new ActionRowBuilder().addComponents(
        button('groups_setup:clear', 'Clear', ButtonStyle.Secondary, '<:emoji_23:1485476368740519986>'),
        button('groups_setup:audit', 'Info', ButtonStyle.Primary, '<:emoji_17:1485476188091580446>')
      ));
    }
    return componentsV2Payload(c);
  };
  return [make('GROUP SETTINGS', sections.slice(0, 8), true), make('', sections.slice(8), false, true)];
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
  const c = baseContainer(guild, 'GROUP ADMIN', '');
  const items = [
    ['Create', '**إنشاء قروب جديد**', 'groups_admin:create', '<:emoji_33:1465383525644501238>', ButtonStyle.Secondary],
    ['Add', '**إضافة قروب من رول**', 'groups_admin:add', '<:emoji_30:1465383419641856233>', ButtonStyle.Secondary],
    ['Info', '**عرض القروب والأعضاء**', 'groups_admin:info', '<:emoji_33:1465383582292771025>', ButtonStyle.Secondary],
    ['Edit', '**تعديل القروب**', 'groups_admin:edit', '<:emoji_35:1465383704993202452>', ButtonStyle.Secondary],
    ['Delete', '**حذف القروب**', 'groups_admin:delete', '<:emoji_21:1465336647477493894>', ButtonStyle.Danger],
    ['Cleanup', '**إكمال حذف قروب**', 'groups_admin:cleanup', '<:emoji_21:1465336647477493894>', ButtonStyle.Danger],
    ['Reset', '**تصفير نقاط قروب**', 'groups_admin:reset', '<:emoji_34:1465383644339241073>', ButtonStyle.Danger],
    ['Reset All', '**تصفير نقاط الكل**', 'groups_admin:resetall', '<:emoji_26:1465373714060415180>', ButtonStyle.Danger]
  ];
  for (const [label, description, id, emoji, style] of items) {
    c.addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(description))
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
async function notifyGroupDM(guild, userId, title, content) {
  if (!userId) return false;
  const member = await guild.members.fetch(String(userId)).catch(() => null);
  if (!member?.send) return false;
  const payload = responsePayload({
    title: safe(title, 80) || 'GROUP UPDATE',
    content: String(content || 'تم تحديث حالة القروب.'),
    thumbnail: groupThumb(guild),
    allowedMentions: { parse: [] }
  });
  try { await member.send(payload); return true; }
  catch (error) {
    console.warn('[groups] private group notification could not be delivered:', String(userId), error?.message || error);
    return false;
  }
}
async function notifyGroupParties(guild, group, actorId, title, content) {
  const recipients = [...new Set([String(group?.owner_id || ''), String(actorId || '')].filter(Boolean))];
  return Promise.all(recipients.map(userId => notifyGroupDM(guild, userId, title, content)));
}
function groupResourceSummary(group) {
  const role = group?.role_id ? `<@&${group.role_id}>` : 'غير متاح';
  const text = group?.text_channel_id ? `<#${group.text_channel_id}>` : 'غير متاح';
  const thread = group?.thread_id ? `<#${group.thread_id}>` : 'غير مستخدم';
  const voice = group?.voice_channel_id ? `<#${group.voice_channel_id}>` : 'غير متاح';
  return `**Name :** ${safe(group?.name || 'غير معروف', 100)}\n**Owner :** <@${group?.owner_id}>\n**Role :** ${role}\n**Text Channel :** ${text}\n**Thread :** ${thread}\n**Voice Channel :** ${voice}`;
}
async function deny(interaction, message='لا تملك صلاحية استخدام هذه العملية.') { return reply(interaction,{content:message}); }
function setupConfirmation(interaction, title, text) { const c = baseContainer(interaction.guild, title, `**- ${safe(text, 300)} **`); return componentsV2Payload(c); }
async function checkSystem(interaction) { const settings=await gm.getSettings(interaction.guild.id); if(!gm.canManageGroupAdmin(interaction.client, settings, interaction.member)){await deny(interaction,'لا تملك صلاحية استخدام هذه العملية. يجب أن يعيّنك مالك البوت مسؤولًا عن نظام القروبات أولًا.');return null;} return settings; }
async function checkBotOwner(interaction) { const settings=await gm.getSettings(interaction.guild.id); if(!gm.isBotOwner(interaction.client, interaction.member)){await deny(interaction,'لا تملك صلاحية تعديل إعدادات النظام. هذه العملية مخصصة لمالكي البوت فقط.');return null;} return settings; }
function musicResultMessage(result) { if(!result) return 'لم يتم تنفيذ الميوزك.'; if(result.ok) return result.alreadyPresent ? `بوت الأغاني ${result.musicBot.user.username} موجود بالفعل في القناة.` : `تم سحب بوت الأغاني ${result.musicBot.user.username} إلى القناة.`; const messages={MUSIC_CHANNEL_NOT_CONFIGURED:'لم يتم تحديد قناة مصدر الميوزك.',INVALID_MUSIC_CHANNEL:'قناة مصدر الميوزك غير صالح.',MUSIC_BOT_NOT_FOUND:'لم يتم العثور على بوت أغاني معروف في قناة المصدر.',AMBIGUOUS_SOURCE_BOTS:'يوجد أكثر من بوت أغاني في المصدر؛ لم يتم اختيار بوت عشوائياً.',AMBIGUOUS_TARGET_BOTS:'يوجد أكثر من بوت أغاني في القناة الهدف؛ لم يتم تغيير أي بوت.',MISSING_PERMISSIONS:`صلاحيات البوت ناقصة : ${result.error||'غير معروفة'}`,MOVE_FAILED:'تعذر نقل بوت الأغاني حالياً.',TARGET_IS_MUSIC_CHANNEL:'القناة الهدف هو قناة المصدر نفسه.'}; return messages[result.code]||'تعذر تنفيذ Music بأمان.'; }
function isGroupMember(group, userId) {
  const id = String(userId || '');
  return Boolean(id && (String(group?.owner_id) === id || group?.memberIds?.includes(id) || group?.managerIds?.includes(id)));
}
async function hasCurrentGroupMembership(guild, group, userId) {
  const id = String(userId || '');
  if (!isGroupMember(group, id) || !group?.role_id) return false;
  const member = await guild.members.fetch(id).catch(() => null);
  const role = guild.roles.cache.get(String(group.role_id)) || await guild.roles.fetch(String(group.role_id)).catch(() => null);
  return Boolean(member && role && member.roles?.cache?.has(role.id));
}
function selectMemberGroup(groups, userId, channelId, requestedGroupId = null) {
  const list = Array.isArray(groups) ? groups : [];
  const requested = requestedGroupId == null ? null : list.find(group => String(group.id) === String(requestedGroupId));
  if (requested && (isGroupMember(requested, userId) || gm.channelBelongs(requested, channelId))) return requested;
  return list.find(group => gm.channelBelongs(group, channelId) && isGroupMember(group, userId))
    || list.find(group => isGroupMember(group, userId)) || null;
}
function groupPickerPayload(guild, action, groups) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`groups_top:pick:${action}`)
    .setPlaceholder('اختر القروب المطلوب')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(groups.slice(0, 25).map(group => ({
      label: safe(group.name || `Group ${group.id}`, 100),
      value: String(group.id),
      description: `القروب : ${safe(group.name || 'غير معروف', 80)}`,
      emoji: group.emoji || '<:emoji_18:1485476234199826472>'
    })));
  const c = baseContainer(guild, action === 'rank' ? 'MY RANK' : 'MY GROUP', 'لديك أكثر من قروب. اختر القروب المطلوب :');
  c.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
  return componentsV2Payload(c);
}
function topGroupsButtons(canManage = false, manageableGroupId = null) {
  const buttons = [
    button('groups_top:rank', 'MY RANK', ButtonStyle.Secondary, '<:emoji_17:1485476100774821938>'),
    button('groups_top:group', 'MY GROUP', ButtonStyle.Secondary, '<:emoji_18:1485476234199826472>'),
    button('groups_top:manage', 'MANAGE', ButtonStyle.Secondary, '<:emoji_30:1465383419641856233>'),
    button('groups_top:avatar', 'AVATAR', ButtonStyle.Secondary, '<:emoji_3:1465210427494502400>')
  ];
  return [new ActionRowBuilder().addComponents(buttons)];
}
function topManagePayload(guild) {
  const c = baseContainer(guild, 'BONUS POINTS MANAGEMENT', 'إدارة نقاط البونص اليدوية للقروبات والأعضاء. هذا النظام منفصل عن نقاط نشاط القروبات.');
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
  const settings = await gm.getSettings(guild.id);
  const viewer = viewerId && String(viewerId) === String(guild.ownerId)
    ? { id: String(viewerId) }
    : viewerId ? await guild.members?.fetch?.(String(viewerId)).catch(() => null) : null;
  const canManage = Boolean(viewer && (String(viewer.id) === String(guild.ownerId) || gm.canManageSystem(guild.client, settings, viewer)));
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
      groupAvatars[String(group.id)] = group.avatar_url || owner?.displayAvatarURL?.({ extension: 'png', size: 128 }) || null;
    } catch { groupAvatars[String(group.id)] = null; }
  }));
  const attachment = await renderTopGroups({ guild, groups, memberRowsByGroup, groupAvatars, selectedGroup, viewerId, accentColor: null });
  // Keep this dashboard as a legacy image message: unlike interactive
  // confirmations, the image already contains the presentation and should not
  // be wrapped in an extra Components V2 container.
  const nextRefresh = Math.ceil((Date.now() + TOP_BOARD_REFRESH_MS) / 1000);
  return { title: 'TOP GROUPS', content: `Group ranking by activity points.\nRefresh in : <t:${nextRefresh}:R>`, files: [attachment], components: topGroupsButtons(canManage), allowedMentions: { parse: [] } };
}
function formatGroupDate(value) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function myGroupPayload(guild, group, userId, memberPoints, roleName) {
  const status = String(group.status || 'active').toLowerCase();
  const membership = String(group.owner_id) === String(userId) ? 'Owner'
    : group.managerIds.includes(String(userId)) ? 'Group Manager' : 'Member';
  const c = baseContainer(guild, 'MY GROUP', safe(group.name, 100));
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `### ${safe(group.name, 100)}\n**Role :** ${membership}   •   **Status :** ${status === 'active' ? 'Active' : status === 'orphaned' ? 'Needs cleanup' : status}`
  ));
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `### GROUP DETAILS\n**Owner :** <@${group.owner_id}>\n**Role :** ${safe(roleName || 'Unavailable', 100)}\n**Members :** ${new Set([String(group.owner_id || ''), ...(group.memberIds || []).map(String), ...(group.managerIds || []).map(String)].filter(Boolean)).size.toLocaleString('en-US')}`
  ));
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `### POINTS & DATES\n**Group Points :** ${Number(group.points || 0).toLocaleString('en-US')}\n**Your Points :** ${Number(memberPoints?.points || 0).toLocaleString('en-US')}\n**Created At :** ${formatGroupDate(group.created_at)}`
  ));
  const groupActions = [];
  if (String(group.owner_id) === String(userId)) groupActions.push(button(`groups_top:transfer:${group.id}`, 'TRANSFER OWNERSHIP', ButtonStyle.Primary));
  groupActions.push(button(`groups_top:leave:${group.id}`, 'LEAVE GROUP', ButtonStyle.Secondary, '<:emoji_23:1485476405151268904>'));
  c.addActionRowComponents(new ActionRowBuilder().addComponents(groupActions));
  return componentsV2Payload(c);
}
function leaveGroupPrompt(guild, group) {
  const c = baseContainer(guild, 'CONFIRM LEAVE', `أنت على وشك مغادرة **${safe(group.name, 100)}**. ستُزال رتبة القروب وصلاحية الوصول إلى الثريد الخاص به.`);
  c.addActionRowComponents(new ActionRowBuilder().addComponents(
    button(`groups_top:leave-confirm:${group.id}`, 'CONFIRM LEAVE', ButtonStyle.Danger),
    button(`groups_top:leave-cancel:${group.id}`, 'إلغاء', ButtonStyle.Secondary)
  ));
  return componentsV2Payload(c);
}
const topPanelLocks = new Map();
const TOP_BOARD_REFRESH_MS = 30_000;
const topPanelRefreshTimers = new Map();
const topPanelRefreshChannels = new Map();
const topPanelMessageIds = new Map();
const groupRoleSyncLocks = new Set();
const groupResourceLocks = new Map();

async function withGroupResourceLock(guildId, groupId, work) {
  const key = `${guildId}:${groupId}`;
  const previous = groupResourceLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  groupResourceLocks.set(key, current);
  await previous;
  try { return await work(); } finally { release(); if (groupResourceLocks.get(key) === current) groupResourceLocks.delete(key); }
}

function groupResourceMemberIds(group) {
  return [...new Set([group.owner_id, ...group.memberIds, ...group.managerIds].filter(Boolean).map(String))];
}

function retryableDiscordError(error) {
  const code = Number(error?.code);
  return code === 429 || [500, 502, 503, 504].includes(code) || /rate.?limit|temporar|timeout|network/i.test(String(error?.message || ''));
}
async function withDiscordRetry(work, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await work(); } catch (error) {
      lastError = error;
      if (!retryableDiscordError(error) || attempt === attempts - 1) throw error;
      const retryAfter = Number(error?.retryAfter || error?.rawError?.retry_after || 0);
      await new Promise(resolve => setTimeout(resolve, Math.min(10000, retryAfter > 0 ? retryAfter * 1000 : 250 * (attempt + 1))));
    }
  }
  throw lastError;
}
async function restoreThreadMember(thread, userId) {
  if (!thread?.members?.add) return false;
  try {
    if (thread.archived && thread.setArchived) await withDiscordRetry(() => thread.setArchived(false, 'Sync managed group thread access'), 3);
    await withDiscordRetry(() => thread.members.add(String(userId)), 3);
    return true;
  }
  catch (error) { console.error('[groups] failed to restore thread member:', thread.id, userId, error?.message || error); return false; }
}

async function syncGroupThreadMembers(guild, group, thread, role = null) {
  if (!thread?.members?.add) return [];
  const roleMemberIds = role?.members ? [...role.members.keys()] : [];
  const memberIds = [...new Set([...groupResourceMemberIds(group), ...roleMemberIds].filter(Boolean).map(String))];
  const failed = [];
  await runWithConcurrency(memberIds, 4, async userId => {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member?.user?.bot) return;
    if (!(await restoreThreadMember(thread, userId))) failed.push(userId);
  });
  return failed;
}

async function migrateDuplicateGroupThread(thread, canonical) {
  const replacement = await withDiscordRetry(() => canonical.threads.create({
    name: String(thread.name || 'Group').slice(0, 100), type: ChannelType.PrivateThread, invitable: false,
    reason: 'Migrate thread from duplicate groups-chat parent'
  }));
  let members = [];
  let memberFetchFailed = false;
  try {
    const collection = await thread.members?.fetch?.();
    if (!collection) memberFetchFailed = true;
    members = collection ? [...collection.keys()] : [];
  } catch { memberFetchFailed = true; }
  const failed = [];
  await runWithConcurrency(members, 4, async userId => {
    if (!(await restoreThreadMember(replacement, userId))) failed.push(userId);
  });
  if (memberFetchFailed || failed.length || !replacement.isThread?.() || String(replacement.parentId) !== String(canonical.id)) {
    await replacement.delete('Rollback incomplete duplicate thread migration').catch(() => {});
    throw new Error(`THREAD_TRANSFER_INCOMPLETE:${failed.length}`);
  }
  if (thread.archived) await replacement.setArchived?.(true, 'Preserve archived state after groups-chat migration').catch(() => {});
  try { await thread.delete('Remove duplicate groups-chat thread after migration'); }
  catch (error) { if (Number(error?.code) !== 10003) { await replacement.delete('Rollback failed duplicate thread migration').catch(() => {}); throw error; } }
  return replacement;
}

async function consolidateThreadGroupChats(guild, settings, groups) {
  if (settings.chatMode !== 'threads') return;
  const linkedParentIds = [...new Set(groups.map(group => String(group.text_channel_id || '')).filter(Boolean))];
  const parentsById = new Map();
  const fetchedChannels = await guild.channels.fetch().catch(() => guild.channels.cache);
  for (const channel of fetchedChannels.values()) {
    if (channel?.type === ChannelType.GuildText
      && String(channel.name || '').toLowerCase() === 'groups-chat'
      && (!settings.textCategoryId || String(channel.parentId || '') === String(settings.textCategoryId))) {
      parentsById.set(channel.id, channel);
    }
  }
  for (const id of linkedParentIds) {
    const channel = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
    if (channel?.type === ChannelType.GuildText) parentsById.set(channel.id, channel);
  }
  // Prefer the parent that already contains the most threads. On a tie,
  // Discord snowflakes sort chronologically, so the oldest parent wins.
  const parentScores = await Promise.all([...parentsById.values()].map(async parent => ({
    parent,
    threadCount: (await threadChoices(parent).catch(() => [])).length
  })));
  parentScores.sort((a, b) => b.threadCount - a.threadCount || String(a.parent.id).localeCompare(String(b.parent.id)));
  const parents = parentScores.map(item => item.parent);
  if (!parents.length && !groups.length) return;
  let canonical = parents[0] || null;
  if (!canonical) {
    canonical = (await gm.getOrCreateSharedGroupChat(guild, settings)).text;
  }
  const textPermission = { ViewChannel: true, SendMessages: true, SendMessagesInThreads: true, ReadMessageHistory: true };
  const managedThreadIds = new Set(groups.map(group => String(group.thread_id || '')).filter(Boolean));
  await runWithConcurrency(groups, 4, async group => {
    const role = group.role_id && (guild.roles.cache.get(String(group.role_id)) || await guild.roles.fetch(String(group.role_id)).catch(() => null));
    if (role) await canonical.permissionOverwrites.edit(role.id, textPermission, { reason: 'Sync shared managed group chat permissions' }).catch(() => {});
    let thread = group.thread_id && (guild.channels.cache.get(String(group.thread_id)) || await guild.channels.fetch(String(group.thread_id)).catch(() => null));
    const oldParentId = String(group.text_channel_id || '');
    if (!thread?.isThread?.() || thread.parentId !== canonical.id) {
      const oldThread = thread?.isThread?.() ? thread : null;
      const replacement = await withDiscordRetry(() => canonical.threads.create({
        name: String(group.name || 'Group').slice(0, 100), type: ChannelType.PrivateThread, invitable: false,
        reason: 'Move managed group thread to shared group chat'
      }));
      try {
        const failed = await syncGroupThreadMembers(guild, group, replacement, role);
        if (failed.length || !replacement.isThread?.() || String(replacement.parentId) !== String(canonical.id)) throw new Error(`THREAD_TRANSFER_INCOMPLETE:${failed.length}`);
        await gm.updateGroup(guild.id, group.id, { text_channel_id: canonical.id, thread_id: replacement.id, updated_at: Date.now() }, null);
        if (oldThread) {
          try { await oldThread.delete('Replace managed group thread in shared group chat'); }
          catch (error) { if (Number(error?.code) !== 10003) throw error; }
          managedThreadIds.delete(oldThread.id);
        }
        thread = replacement;
        managedThreadIds.add(thread.id);
      } catch (error) {
        if (oldThread) await gm.updateGroup(guild.id, group.id, { text_channel_id: oldParentId, thread_id: oldThread.id, updated_at: Date.now() }, null).catch(() => {});
        await replacement.delete('Rollback incomplete managed thread migration').catch(() => {});
        throw error;
      }
    } else if (oldParentId !== canonical.id) {
      await gm.updateGroup(guild.id, group.id, { text_channel_id: canonical.id, updated_at: Date.now() }, null);
    }
    const failed = await syncGroupThreadMembers(guild, group, thread, role);
    if (failed.length) await gm.audit(guild.id, null, group.id, 'group_thread_member_sync_failed', { userIds: failed }).catch(() => {});
  });
  for (const parent of parents) {
    if (parent.id === canonical.id) continue;
    const remainingThreads = await threadChoices(parent).catch(() => null);
    if (!Array.isArray(remainingThreads)) {
      console.warn('[groups] kept duplicate group-chat parent because its threads could not be verified:', parent.id);
      continue;
    }
    let migrationFailed = false;
    for (const thread of remainingThreads) {
      try {
        const replacement = await migrateDuplicateGroupThread(thread, canonical);
        const linkedGroup = groups.find(group => String(group.thread_id) === String(thread.id));
        if (linkedGroup) {
          await gm.updateGroup(guild.id, linkedGroup.id, { text_channel_id: canonical.id, thread_id: replacement.id, updated_at: Date.now() }, null);
          managedThreadIds.add(replacement.id);
        }
      } catch (error) {
        migrationFailed = true;
        console.error('[groups] failed to migrate duplicate group-chat thread:', parent.id, thread.id, error?.message || error);
      }
    }
    const remainingAfterMigration = !migrationFailed ? await threadChoices(parent).catch(() => null) : null;
    if (!migrationFailed && Array.isArray(remainingAfterMigration) && remainingAfterMigration.length === 0) {
      await parent.delete('Remove duplicate groups-chat parent after verified thread migration').catch(error => {
        console.warn('[groups] failed to delete verified duplicate group-chat parent:', parent.id, error?.message || error);
      });
    } else {
      console.warn('[groups] kept duplicate group-chat parent because migration verification failed or threads remain:', parent.id);
    }
  }
}

async function runWithConcurrency(items, concurrency, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), queue.length || 1) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(workers);
}

async function restoreGroupRole(guild, group, forceMissing = false) {
  let role = !forceMissing && group.role_id && (guild.roles.cache.get(String(group.role_id)) || await guild.roles.fetch(String(group.role_id)).catch(() => null));
  if (role) return { role, group };
  const settings = await gm.getSettings(guild.id);
  role = await withDiscordRetry(() => guild.roles.create({ name: String(group.name || 'Group').slice(0, 100), color: /^#[0-9a-f]{6}$/i.test(group.color || '') ? group.color : undefined, reason: 'Restore deleted managed group role' }));
  if (settings.mainRoleId) {
    const mainRole = guild.roles.cache.get(settings.mainRoleId) || await guild.roles.fetch(settings.mainRoleId).catch(() => null);
    if (mainRole) await role.setPosition(Math.max(1, mainRole.position - 1), 'Restore managed group role position').catch(() => {});
  }
  const updated = await gm.updateGroup(guild.id, group.id, { role_id: role.id, status: 'active', updated_at: Date.now() }, null);
  return { role, group: updated || { ...group, role_id: role.id, status: 'active' } };
}

function groupChannelOverwrites(guild, roleId) {
  return [
    { id: guild.roles.everyone.id, deny: ['ViewChannel'] },
    { id: roleId, allow: GROUP_TEXT_ACCESS.concat(GROUP_VOICE_ACCESS) }
  ];
}
const GROUP_TEXT_ACCESS = ['ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'ReadMessageHistory', 'AddReactions', 'AttachFiles', 'EmbedLinks', 'UseExternalEmojis', 'UseExternalStickers'];
const GROUP_VOICE_ACCESS = ['ViewChannel', 'Connect', 'Speak', 'Stream', 'UseVAD'];
function groupVoiceOverwrites(guild, roleId) {
  return [
    { id: guild.roles.everyone.id, allow: ['ViewChannel'], deny: ['Connect'] },
    { id: roleId, allow: GROUP_VOICE_ACCESS }
  ];
}

async function restoreGroupResources(guild, sourceGroup, trigger = 'resource_deleted') {
  return withGroupResourceLock(guild.id, sourceGroup.id, async () => {
    const lockKey = `group:${guild.id}:${sourceGroup.id}:resources`;
    const operationToken = await gm.acquireOperationLock(lockKey, 180000);
    if (!operationToken) return null;
    try {
    let group = await gm.getGroup(guild.id, sourceGroup.id);
    if (!group || group.status === 'deleted') return null;
    await gm.updateGroup(guild.id, group.id, { sync_state: 'repairing', updated_at: Date.now() }, null);
    await gm.runtimeLog(guild.id, group.id, 'resource_repair', 'info', { trigger }).catch(() => {});
    const roleResult = await restoreGroupRole(guild, group, String(trigger).startsWith('role_deleted:'));
    group = roleResult.group;
    const settings = await gm.getSettings(guild.id);
    const patch = { status: 'active', updated_at: Date.now() };
    let text = group.text_channel_id && (guild.channels.cache.get(group.text_channel_id) || await guild.channels.fetch(group.text_channel_id).catch(() => null));
    let voice = group.voice_channel_id && (guild.channels.cache.get(group.voice_channel_id) || await guild.channels.fetch(group.voice_channel_id).catch(() => null));
    let thread = group.thread_id && (guild.channels.cache.get(group.thread_id) || await guild.channels.fetch(group.thread_id).catch(() => null));
    if (!text || text.type !== ChannelType.GuildText) {
      text = settings.chatMode === 'threads' ? await findSharedGroupChat(guild, settings) : null;
      if (!text && settings.chatMode === 'threads') throw new Error('SHARED_GROUP_CHAT_UNAVAILABLE');
      if (!text) text = await withDiscordRetry(() => guild.channels.create({ name: `📝・${String(group.name || 'Group').slice(0, 90)}`, type: ChannelType.GuildText, parent: settings.textCategoryId || undefined, permissionOverwrites: groupChannelOverwrites(guild, roleResult.role.id), reason: 'Restore deleted managed group text channel' }));
      patch.text_channel_id = text.id;
      thread = null;
      if (settings.chatMode === 'threads') await text.permissionOverwrites.edit(roleResult.role.id, {
        ViewChannel: true, SendMessages: true, SendMessagesInThreads: true, ReadMessageHistory: true
      }, { reason: 'Restore managed group role in shared group chat' }).catch(() => {});
    } else {
      await text.permissionOverwrites.edit(roleResult.role.id, {
        ViewChannel: true, SendMessages: true, SendMessagesInThreads: true, ReadMessageHistory: true
      }, { reason: 'Restore managed group text permissions' }).catch(() => {});
    }
    if (settings.chatMode === 'threads') {
      if (!thread || !thread.isThread?.() || !thread.members) {
        thread = await withDiscordRetry(() => text.threads.create({ name: String(group.name || 'Group').slice(0, 100), type: ChannelType.PrivateThread, invitable: false, reason: 'Restore deleted managed group thread' }));
        patch.thread_id = thread.id;
      }
    } else if (group.thread_id) {
      patch.thread_id = null;
    }
    if (!voice || voice.type !== ChannelType.GuildVoice) {
      voice = await withDiscordRetry(() => guild.channels.create({ name: String(group.name || 'Group').slice(0, 100), type: ChannelType.GuildVoice, parent: settings.voiceCategoryId || undefined, permissionOverwrites: groupVoiceOverwrites(guild, roleResult.role.id), reason: 'Restore deleted managed group voice channel' }));
      patch.voice_channel_id = voice.id;
    } else {
      await voice.permissionOverwrites.edit(guild.roles.everyone.id, { ViewChannel: true, Connect: false }, { reason: 'Restore public voice visibility and deny public connect' }).catch(() => {});
      await voice.permissionOverwrites.edit(roleResult.role.id, {
        ViewChannel: true, Connect: true, Speak: true, Stream: true, UseVAD: true
      }, { reason: 'Restore managed group voice permissions' }).catch(() => {});
    }
    group = await gm.updateGroup(guild.id, group.id, { ...patch, sync_state: 'ready' }, null);
    const failedThreadMembers = [];
    const roleMemberIds = roleResult.role.members ? [...roleResult.role.members.keys()] : [];
    const memberIds = [...new Set([...groupResourceMemberIds(group), ...roleMemberIds].filter(Boolean).map(String))];
    await runWithConcurrency(memberIds, 4, async userId => {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member && !member.user?.bot) await member.roles.add(roleResult.role, 'Restore managed group membership').catch(() => {});
      if (thread?.members && !(await restoreThreadMember(thread, userId))) failedThreadMembers.push(String(userId));
    });
    await gm.audit(guild.id, null, group.id, 'group_resource_restored', { trigger, roleId: roleResult.role.id, textChannelId: group.text_channel_id, threadId: group.thread_id, voiceChannelId: group.voice_channel_id }).catch(() => {});
    if (failedThreadMembers.length) {
      await gm.audit(guild.id, null, group.id, 'group_thread_members_restore_failed', { trigger, threadId: group.thread_id, userIds: failedThreadMembers }).catch(() => {});
    }
    await gm.logGroupEvent(guild, 'update', { groupId: group.id, reason: 'group_resource_restored', trigger, roleId: roleResult.role.id, textChannelId: group.text_channel_id, threadId: group.thread_id, voiceChannelId: group.voice_channel_id }, null);
    activityCache.delete(String(guild.id));
    return group;
    } catch (error) {
      await gm.updateGroup(guild.id, sourceGroup.id, { sync_state: 'repair_failed', updated_at: Date.now() }, null).catch(() => {});
      await gm.runtimeLog(guild.id, sourceGroup.id, 'resource_repair', 'error', { trigger, message: String(error?.message || error).slice(0, 300) }).catch(() => {});
      throw error;
    } finally {
      await gm.releaseOperationLock(lockKey, operationToken);
    }
  });
}
function scheduleTopPanelRefresh(channel, guild, options = {}) {
  // One timer per guild: a new configured channel replaces the old timer instead of leaking intervals.
  const key = String(guild?.id || channel?.id || 'top-groups');
  const previous = topPanelRefreshTimers.get(key);
  if (previous && topPanelRefreshChannels.get(key) === String(channel?.id || '')) return;
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
  topPanelRefreshChannels.set(key, String(channel?.id || ''));
}
function isComponentsV2Message(message) {
  if (message?.flags?.has?.(MessageFlags.IsComponentsV2)) return true;
  const rawFlags = typeof message?.flags === 'number' ? message.flags : message?.flags?.bitfield;
  return (Number(rawFlags || 0) & MessageFlags.IsComponentsV2) !== 0;
}
async function sendTopGroupsPanel(channel, guild, options = {}) {
  const settings = await gm.getSettings(guild.id).catch(() => null);
  const configuredChannelId = String(settings?.topChannelId || '');
  if (!configuredChannelId || !channel?.id || String(channel.id) !== configuredChannelId || channel.isThread?.()) {
    return null;
  }
  const key = String(channel?.id || guild?.id || 'top-groups');
  if (topPanelLocks.has(key)) return topPanelLocks.get(key);
  const work = (async () => {
    const payload = await buildTopGroupsPayload(guild, { ...options, channelId: options.channelId || channel?.id });
    const botId = guild?.client?.user?.id;
    let existing = null;
    const knownMessageId = topPanelMessageIds.get(key);
    if (knownMessageId) {
      const fetched = await channel?.messages?.fetch?.(knownMessageId).catch(() => null);
      existing = fetched?.edit ? fetched : null;
    }
    if (!existing) {
      const messages = await channel?.messages?.fetch?.({ limit: 50 }).catch(() => null);
      existing = messages && [...messages.values()]
        .filter(message => (!botId || message.author?.id === botId) && JSON.stringify(message.components || []).includes('groups_top:'))
        .sort((a, b) => Number(a.createdTimestamp || 0) - Number(b.createdTimestamp || 0)).pop();
    }
    if (existing?.edit) {
      const edited = await existing.edit(payload).catch(() => null);
      if (edited) {
        if (edited.id) topPanelMessageIds.set(key, String(edited.id));
        scheduleTopPanelRefresh(channel, guild, options);
        return edited;
      }
      // If Discord rejected the edit (deleted/stale/invalid message), publish
      // a fresh panel and remove the stale one after the new message exists.
    }
    const sent = await channel.send(payload);
    if (sent.id) topPanelMessageIds.set(key, String(sent.id));
    if (existing?.delete) await Promise.resolve(existing.delete()).catch(() => null);
    scheduleTopPanelRefresh(channel, guild, options);
    return sent;
  })();
  topPanelLocks.set(key, work);
  try { return await work; } finally { topPanelLocks.delete(key); }
}
async function refreshConfiguredTopBoards(client) {
  const jobs = [...(client?.guilds?.cache?.values?.() || [])].map(async guild => {
    const settings = await gm.getSettings(guild.id).catch(() => null);
    const channelId = settings?.topChannelId;
    if (!channelId) return null;
    const channel = guild.channels.cache.get(String(channelId)) || await guild.channels.fetch(String(channelId)).catch(() => null);
    if (!channel || channel.isThread?.() || !channel.isTextBased?.()) return null;
    return sendTopGroupsPanel(channel, guild, { channelId: channel.id }).catch(error => {
      console.error('[groups] startup top-board refresh failed:', guild.id, error?.message || error);
      return null;
    });
  });
  await Promise.allSettled(jobs);
}
async function handleTopGroupsInteraction(interaction, action, parts = []) {
  const viewAction = action === 'pick' ? String(parts[0] || '') : action;
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
  if (action === 'avatar') {
    const groups = await gm.listGroups(interaction.guild.id);
    const group = selectMemberGroup(groups, interaction.user.id, interaction.channelId);
    if (!group || !gm.canManageGroup(interaction.client, await gm.getSettings(interaction.guild.id), group, interaction.member)) return reply(interaction, { content: 'تغيير Avatar متاح لمالك القروب أو مسؤوليه فقط.' });
    const modal = new ModalBuilder().setCustomId(`groups_top:avatar-modal:${group.id}`).setTitle('EDIT GROUP AVATAR');
    modal.addLabelComponents(new LabelBuilder().setLabel('رابط صورة أو إيموجي القروب').setTextInputComponent(new TextInputBuilder().setCustomId('value').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500).setPlaceholder('Discord CDN أو Custom Emoji، اتركه فارغًا للإزالة')));
    return interaction.showModal(modal);
  }
  if (action === 'avatar-modal') {
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const groupId = Number(parts[0]);
    const group = await gm.getGroup(interaction.guild.id, groupId);
    const settings = await gm.getSettings(interaction.guild.id);
    if (!group || !gm.canManageGroup(interaction.client, settings, group, interaction.member)) return reply(interaction, { content: 'تغيير Avatar متاح لمالك القروب أو مسؤوليه فقط.' });
    const rawValue = interaction.fields.getTextInputValue('value').trim();
    const avatarUrl = normalizeGroupAvatar(rawValue);
    if (rawValue && !avatarUrl) return reply(interaction, { content: 'أرسل رابط صورة من Discord CDN أو إيموجيًا مخصصًا صالحًا.' });
    await gm.updateGroup(interaction.guild.id, groupId, { avatar_url: avatarUrl, updated_at: Date.now() }, interaction.user.id);
    invalidateGroupCaches(interaction.guild.id);
    return reply(interaction, { content: avatarUrl ? 'تم تحديث Avatar القروب؛ سيظهر في التوب عند التحديث القادم.' : 'تمت إزالة Avatar القروب والعودة للصورة الافتراضية.' });
  }
  if (action === 'transfer') {
    const group = await gm.getGroup(interaction.guild.id, Number(parts[0]));
    if (!group || String(group.owner_id) !== String(interaction.user.id)) return reply(interaction, { content: 'نقل الملكية متاح لمالك القروب الحالي فقط.' });
    const menu = new UserSelectMenuBuilder().setCustomId(`groups_top:transfer-select:${group.id}`).setPlaceholder('اختر عضوًا حاليًا لنقل الملكية').setMinValues(1).setMaxValues(1);
    const c = baseContainer(interaction.guild, 'TRANSFER GROUP OWNERSHIP', `اختر عضوًا من **${safe(group.name, 100)}**. ستنتقل رتبة المالك إليه، ويمكنك بعدها مغادرة القروب.`);
    c.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
    c.addActionRowComponents(new ActionRowBuilder().addComponents(button('groups_top:group', 'إلغاء', ButtonStyle.Secondary)));
    return reply(interaction, componentsV2Payload(c));
  }
  if (action === 'transfer-select') {
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try { return reply(interaction, { content: await transferGroupOwner(interaction, Number(parts[0]), interaction.values?.[0]) }); }
    catch (error) {
      const message = error.message === 'OWNER_MUST_BE_MEMBER' ? 'يجب اختيار عضو حالي في القروب.'
        : error.message === 'USER_ALREADY_IN_GROUP' ? 'تعذر إضافة العضو إلى القروب.'
        : error.message === 'OWNER_ONLY' ? 'هذه العملية متاحة لمالك القروب فقط.' : 'تعذر نقل الملكية. تحقق من صلاحيات البوت والرتب.';
      return reply(interaction, { content: message });
    }
  }
  if (action === 'leave') {
    const group = await gm.getGroup(interaction.guild.id, Number(parts[0]));
    if (!group || group.status !== 'active' || !(await hasCurrentGroupMembership(interaction.guild, group, interaction.user.id))) {
      return reply(interaction, { content: 'لم تعد عضوًا في هذا القروب.' });
    }
    if (String(group.owner_id) === String(interaction.user.id)) {
      return reply(interaction, { content: 'انقل ملكية القروب أولًا قبل المغادرة.' });
    }
    return reply(interaction, leaveGroupPrompt(interaction.guild, group), true);
  }
  if (action === 'leave-cancel') {
    const c = baseContainer(interaction.guild, 'LEAVE CANCELLED', 'لم يتم تغيير عضويتك.');
    c.addActionRowComponents(new ActionRowBuilder().addComponents(button('groups_top:group', 'العودة إلى قروبي', ButtonStyle.Secondary)));
    return reply(interaction, componentsV2Payload(c), true);
  }
  if (action === 'leave-confirm') {
    await interaction.deferUpdate();
    const group = await gm.getGroup(interaction.guild.id, Number(parts[0]));
    if (!group || group.status !== 'active' || !(await hasCurrentGroupMembership(interaction.guild, group, interaction.user.id))) {
      return reply(interaction, componentsV2Payload(baseContainer(interaction.guild, 'LEAVE FAILED', 'لم تعد عضوًا في هذا القروب.')));
    }
    if (String(group.owner_id) === String(interaction.user.id)) {
      return reply(interaction, componentsV2Payload(baseContainer(interaction.guild, 'LEAVE FAILED', 'انقل ملكية القروب أولًا قبل المغادرة.')));
    }
    try {
      const settings = await gm.getSettings(interaction.guild.id);
      await leaveGroupMember(interaction.guild, settings, group, interaction.user.id, interaction.user.id);
      activityCache.delete(String(interaction.guild.id));
      return reply(interaction, componentsV2Payload(baseContainer(interaction.guild, 'LEFT GROUP', `تمت مغادرة **${safe(group.name, 100)}** وإزالة صلاحيات القروب.`)));
    } catch (error) {
      console.error('[groups] member leave failed:', error?.message || error);
      const message = error.message === 'GROUP_ROLE_NOT_FOUND' ? 'رتبة القروب غير موجودة؛ لم يتم إكمال المغادرة.'
        : error.message === 'GROUP_THREAD_NOT_FOUND' ? 'ثريد القروب غير متاح؛ لم يتم إكمال المغادرة.'
          : 'تعذر إكمال المغادرة ومزامنة صلاحيات القروب.';
      return reply(interaction, componentsV2Payload(baseContainer(interaction.guild, 'LEAVE FAILED', message)));
    }
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (viewAction === 'rank' || viewAction === 'group') {
    const groups = await gm.listGroups(interaction.guild.id);
    const memberGroups = groups.filter(group => isGroupMember(group, interaction.user?.id));
    if (action !== 'pick' && memberGroups.length > 1) {
      return interaction.editReply(groupPickerPayload(interaction.guild, viewAction, memberGroups));
    }
    const selectedGroupId = action === 'pick' ? interaction.values?.[0] : null;
    const group = selectMemberGroup(groups, interaction.user?.id, interaction.channelId, selectedGroupId);
    if (!group) return interaction.editReply(responsePayload({ content: viewAction === 'rank' ? 'لا يوجد قروب مرتبط بعضويتك لعرض مركزه.' : 'لا يوجد قروب مرتبط بعضويتك.', allowedMentions: { parse: [] } }));
    if (viewAction === 'rank') {
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
    return interaction.editReply(responsePayload({ title: 'MY GROUP RANK', content: 'ترتيب قروبك ونقاطه مقارنة ببقية القروبات.', files: [attachment], allowedMentions: { parse: [] } }));
    }
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
  const c = baseContainer(guild, 'SELECT GROUP', description);
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
    .setTitle(action.endsWith('add') ? 'ADD POINTS' : 'DEDUCT POINTS');
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
  const c = baseContainer(interaction.guild, 'CONFIRM POINT DEDUCTION', `تأكيد خصم **${amount.toLocaleString()}** نقطة من ${subject}.\nالرصيد الحالي ${current.toLocaleString()} وبعد الخصم ${after.toLocaleString()}.`);
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
  const c = baseContainer(interaction.guild, 'SELECT MEMBER', `اختر عضوًا حاليًا من قروب **${safe(group.name)}**.`);
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
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
      const c = baseContainer(interaction.guild, 'CONFIRM GROUP POINT DEDUCTION', `تأكيد خصم حتى **${amount.toLocaleString()}** نقطة من كل قروب نشط.\nإجمالي النقاط الحالي ${before.toLocaleString()} وبعد الخصم ${after.toLocaleString()}.`);
      c.addActionRowComponents(new ActionRowBuilder().addComponents(
        button(`groups_bonus_confirm:all-remove:${amount}`, 'تأكيد', ButtonStyle.Danger, '<:emoji_21:1465336647477493894>'),
        button('groups_bonus:cancel', 'إلغاء', ButtonStyle.Secondary)
      ));
      return reply(interaction, componentsV2Payload(c), true);
    }
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
function memberGroupPayload(guild, groupId) {
  // The member-control channel is the public control surface for every group.
  // Keep all actions behind currentManager() permission checks, but expose the
  // complete control set here instead of publishing an information-only card.
  return controlGroupPayload(guild, Number(groupId));
}
async function sendGroupPanel(channel, guild, groupId) {
  const payload = { ...memberGroupPayload(guild, groupId), allowedMentions: { parse: [] } };
  const id = Number(groupId);
  const messages = await channel?.messages?.fetch?.({ limit: 100 }).catch(() => null);
  const botId = guild?.client?.user?.id;
  const marker = `groups_member:info:${id}`;
  const existing = messages && [...messages.values()].filter(message =>
    (!botId || message.author?.id === botId) && JSON.stringify(message.components || []).includes(marker)
  ).sort((a, b) => Number(a.createdTimestamp || 0) - Number(b.createdTimestamp || 0)).pop();
  if (existing?.edit) {
    const edited = await existing.edit(payload).catch(() => null);
    if (edited) return edited;
  }
  try { return await channel.send(payload); }
  catch (error) {
    console.error(`تعذر إرسال لوحة معلومات القروب ${groupId}:`, error?.stack || error?.message || error);
    return null;
  }
}
async function sendGroupAdminPanel(channel, guild, groupId) {
  if (!channel?.send) return null;
  return channel.send({ ...groupMetadataPayload(guild, groupId), allowedMentions: { parse: [] } });
}
async function sendMemberControlPanels(channel, guild) {
  const groups = await gm.listGroups(guild.id);
  const activeIds = new Set(groups.map(group => String(group.id)));
  const botId = guild?.client?.user?.id;
  const existingMessages = await channel?.messages?.fetch?.({ limit: 100 }).catch(() => null);
  if (existingMessages) {
    for (const message of existingMessages.values()) {
      if (botId && message.author?.id !== botId) continue;
      const match = JSON.stringify(message.components || []).match(/groups_member:info:(\d+)/);
      if (match && !activeIds.has(match[1])) await message.delete?.('Remove stale managed group member panel').catch(() => null);
    }
  }
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
  const c = baseContainer(guild, 'MEMBER DASHBOARD', description);
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
    `**${safe(group?.name || 'قروب', 80)}**`,
    'اكتب الأمر مباشرة في بداية الرسالة.',
    '',
    '**GROUP**',
    '`تحكم` : لوحة التحكم وبيانات القروب.', '',
    '`صلاحية` : إدارة صلاحيات الرول أو عضو.',
    '',
    '**MEMBERS**',
    '`إضافة @عضو` : إضافة عضو للقروب.', '',
    '`إزالة @عضو` : إزالة عضو من القروب.', '',
    '`منع @عضو` : منع عضو من الوصول.', '',
    '`سماح @عضو` : إعادة وصول عضو ممنوع.',
    '',
    '**VIEW**',
    '`قروبي` : معلومات القروب.', '',
    '`أعضاء` : ترتيب الأعضاء وPoints.', '',
    '`أعضاؤنا` : قائمة الأعضاء، 10 في كل صفحة.', '',
    '`أوامر` : عرض هذا الدليل.',
    '',
    '**MANAGERS**',
    '`مسؤول @عضو` : تعيين مسؤول.', '',
    '`مسؤول إزالة @عضو` : إزالة مسؤول.'
  ];
  if (settings?.extraPermissions) {
    lines.push('', '**EXTRA**', '`مسح` : حذف آخر 100 رسالة.', '', '`عقوبة @عضو` : Timeout لمدة 10 دقائق.');
  }
  return lines.join('\n');
}
async function sendGroupCommandGuide(channel, group, settings) {
  if (!channel?.send) return null;
  return channel.send(responsePayload({ title: 'GROUP COMMANDS', content: groupCommandGuideText(group, settings), accentColor: colorManager.getColor?.(), allowedMentions: { parse: [] } }));
}
function createGroupModal(defaultOwnerId = '') {
  const modal = new ModalBuilder().setCustomId('groups_modal:create').setTitle('CREATE GROUP');
  modal.addLabelComponents(new LabelBuilder().setLabel('اسم القروب').setTextInputComponent(
    new TextInputBuilder().setCustomId('group_name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)
  ));
  modal.addLabelComponents(new LabelBuilder().setLabel('معرف المالك أو منشنه').setTextInputComponent(
    new TextInputBuilder().setCustomId('group_owner').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder(String(defaultOwnerId || ''))
  ));
  return modal;
}
async function createFromModal(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const settings = await checkSystem(interaction);
  if (!settings) return;
  const groupName = safe(interaction.fields.getTextInputValue('group_name'), 80).trim();
  const ownerValue = interaction.fields.getTextInputValue('group_owner') || '';
  const ownerId = ownerValue.match(/\d{16,20}/)?.[0] || interaction.user.id;
  if (!groupName) return reply(interaction, { title: 'GROUP CREATION FAILED', content: 'اسم القروب مطلوب.' });

  await reply(interaction, { title: 'CREATING GROUP', content: 'جارٍ إنشاء القروب وتجهيز الرتبة والقنوات. انتظر حتى تظهر نتيجة العملية.', thumbnail: groupThumb(interaction.guild) });
  let group;
  try {
    group = await gm.createGroup(interaction.guild, { name: groupName, ownerId, color: '#5865F2' }, interaction.user.id);
  } catch (error) {
    const message = error.message?.startsWith('GROUP_SETUP_REQUIRED')
      ? 'أكمل إعدادات القروبات أولًا.'
      : ({ GROUP_SYSTEM_DISABLED: 'نظام القروبات متوقف حاليًا.', BOT_NOT_ALLOWED: 'لا يمكن تعيين بوت كمالك للقروب.', OWNER_ALREADY_HAS_GROUP: 'لا يمكن للعضو امتلاك أكثر من قروب واحد.', GROUP_FULL: 'وصل القروب إلى الحد الأقصى للأعضاء.', NAME_REQUIRED: 'اسم القروب مطلوب وصالح.', MAIN_ROLE_INVALID: 'رتبة النظام الرئيسية غير صالحة؛ راجع الإعدادات.', LEADER_ROLE_INVALID: 'رتبة المالك غير صالحة؛ راجع الإعدادات.', MANAGER_ROLE_INVALID: 'رتبة المسؤول غير صالحة؛ راجع الإعدادات.' })[error.message] || 'تعذر إنشاء القروب. راجع الإعدادات وصلاحيات البوت.';
    return interaction.editReply(responsePayload({ title: 'GROUP CREATION FAILED', content: message, thumbnail: groupThumb(interaction.guild), allowedMentions: { parse: [] } }));
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
  const guideChannel = defaultChannel || panelChannel;
  await sendGroupCommandGuide(guideChannel, group, settings).catch(error => {
    console.error('[groups] failed to publish group command guide:', error?.message || error);
    return null;
  });

  const panelNote = panelChannel && !panelPublished ? '\nتعذر نشر لوحة التحكم تلقائيًا؛ تحقق من صلاحيات البوت في القناة.' : '';
  const details = `${groupResourceSummary(group)}\n**Music :** ${musicResultMessage(musicResult)}${panelNote}`;
  await notifyGroupParties(interaction.guild, group, interaction.user.id, 'GROUP CREATED', `تم إنشاء القروب بنجاح.\n\n${details}`);
  return interaction.editReply(responsePayload({ title: 'GROUP CREATED SUCCESSFULLY', content: `تم إنشاء القروب بنجاح.\n\n${details}`, thumbnail: groupThumb(interaction.guild), allowedMentions: { parse: [] } }));
}
const CLEARABLE_SETUP_FIELDS = [
  ['chatMode', 'CHAT MODE', value => value === 'threads' ? 'ثريدات' : 'رومات مستقلة'],
  ['textCategoryId', 'كاتاقوري النص/الثريدات', value => `<#${value}>`],
  ['voiceCategoryId', 'كاتاقوري الصوت', value => `<#${value}>`],
  ['topChannelId', 'قناة الترتيب', value => `<#${value}>`],
  ['adminControlChannelId', 'قناة تحكم الإدارة', value => `<#${value}>`],
  ['memberControlChannelId', 'قناة تحكم الأعضاء', value => `<#${value}>`],
  ['mainRoleId', 'الرول الرئيسي', value => `<@&${value}>`],
  ['leaderRoleId', 'رول المالك', value => `<@&${value}>`],
  ['managerRoleId', 'رول المسؤول', value => `<@&${value}>`],
  ['musicChannelId', 'قناة مصدر الموسيقى', value => `<#${value}>`],
  ['logChannelId', 'قناة السجلات', value => `<#${value}>`]
];
function managerSetupPayload(guild, settings) {
  const entries = [
    ...settings.systemUsers.map(id => `<@${id}>`),
    ...settings.systemRoles.map(id => `<@&${id}>`)
  ];
  const visible = entries.slice(0, 20);
  const current = visible.length ? visible.join('، ') + (entries.length > visible.length ? `، و${entries.length - visible.length} آخرين` : '') : 'لا يوجد مسؤولو نظام مضافون.';
  const c = baseContainer(guild, 'SYSTEM MANAGERS', `المسؤولون الحاليون (${entries.length}):\n${current}\nيمكنك إضافة حتى 5 أعضاء أو رتب في كل مرة، أو إزالة عدة معرفات دفعة واحدة.`);
  c.addActionRowComponents(new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('groups_setup_manager:add:user').setPlaceholder('إضافة أعضاء').setMinValues(1).setMaxValues(5)));
  c.addActionRowComponents(new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('groups_setup_manager:add:role').setPlaceholder('إضافة رتب').setMinValues(1).setMaxValues(5)));
  c.addActionRowComponents(new ActionRowBuilder().addComponents(button('groups_setup_manager:remove', 'إزالة مسؤولي نظام', ButtonStyle.Danger)));
  return componentsV2Payload(c);
}
function setupManagerRemovalModal() {
  const modal = new ModalBuilder().setCustomId('groups_setup_manager:remove').setTitle('REMOVE SYSTEM MANAGERS');
  modal.addLabelComponents(new LabelBuilder().setLabel('منشن أو معرفات الأعضاء والرتب').setTextInputComponent(new TextInputBuilder().setCustomId('ids').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000).setPlaceholder('مثال: @عضو 123456789012345678')));
  return modal;
}
async function handleSetup(interaction, action) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const settings = await checkBotOwner(interaction);
  if (!settings) return true;
  if (action === 'toggle') {
    if (!settings.enabled) {
      await hydrateSetupReferences(interaction.guild, settings);
      const missing = gm.validateConfig(interaction.guild, settings);
      if (missing.length) return reply(interaction, { content: `لا يمكن تفعيل نظام القروبات قبل إصلاح الإعدادات التالية:\n${missing.map(setupIssueLabel).join('\n')}` });
    }
    const updated = await saveGroupSettings(interaction.guild.id, { enabled: !settings.enabled }, interaction.user.id);
    await refreshSetupPanel(interaction, updated);
    return reply(interaction, setupConfirmation(interaction, 'حالة نظام القروبات', `تم ${!settings.enabled ? 'تفعيل' : 'إيقاف'} نظام القروبات.`));
  }
  if (action === 'audit') {
    await hydrateSetupReferences(interaction.guild, settings);
    const missing = gm.validateConfig(interaction.guild, settings);
    const content = missing.length
      ? `يوجد ${missing.length} نقصًا في الإعداد:\n${missing.map(setupIssueLabel).join('\n')}`
      : `الإعداد مكتمل. النظام ${settings.enabled ? 'مفعل' : 'جاهز لكنه متوقف'}.`;
    return reply(interaction, { content });
  }
  if (action === 'clear') {
    const options = CLEARABLE_SETUP_FIELDS.filter(([key]) => settings[key] != null && settings[key] !== '').map(([key, label, format]) => ({ label: safe(label, 100), value: key, description: safe(`الحالي: ${format(settings[key])}`, 100) }));
    if (!options.length) return reply(interaction, { content: 'لا توجد قيم لمسحها.' });
    return reply(interaction, selectPayload(interaction.guild, 'CLEAR', 'اختر قيمة لمسحها.', 'groups_setup_clear_select', options));
  }
  if (action === 'chatmode') return reply(interaction, selectPayload(interaction.guild, 'CHAT MODE', 'اختر طريقة إنشاء مساحات شات القروبات.', 'groups_setup_select:chatmode', [
    { label: 'ثريدات', value: 'threads', description: 'قناة أب واحد مع ثريدات خاصة' },
    { label: 'رومات', value: 'channels', description: 'قناة نصي مستقل لكل قروب' }
  ]));
  if (action === 'extra') {
    if (!settings.extraPermissions) {
      await hydrateSetupReferences(interaction.guild, settings);
      const extraPermissions = ['ManageMessages', 'ModerateMembers', 'MoveMembers'];
      const missing = gm.validateConfig(interaction.guild, { ...settings, extraPermissions: true })
        .filter(issue => issue.startsWith('permission:') && extraPermissions.includes(issue.slice('permission:'.length)));
      if (missing.length) return reply(interaction, { content: `لا يمكن تفعيل الأدوات الإضافية قبل منح البوت:\n${missing.map(setupIssueLabel).join('\n')}` });
    }
    const updated = await saveGroupSettings(interaction.guild.id, { extraPermissions: !settings.extraPermissions }, interaction.user.id);
    await refreshSetupPanel(interaction, updated);
    return reply(interaction, setupConfirmation(interaction, 'الصلاحيات الإضافية', `تم ${!settings.extraPermissions ? 'تفعيل' : 'تعطيل'} الصلاحيات الإضافية.`));
  }
  if (action === 'scope') return reply(interaction, selectPayload(interaction.guild, 'POINTS SCOPE', 'اختر أين يتم احتساب تفاعل القروبات.', 'groups_setup_select:scope', [
    { label: 'رومات القروبات فقط', value: 'group', description: 'رومات نص وفويس القروبات فقط' },
    { label: 'كل الرومات', value: 'all', description: 'كل رومات السيرفر المقروءة' }
  ]));
  if (['log', 'topchannel', 'adminchannel', 'memberchannel'].includes(action)) {
    const menu = new ChannelSelectMenuBuilder().setCustomId(`groups_setup_channel:${action}`).setPlaceholder('اختر قناة نصية').setMinValues(1).setMaxValues(1).setChannelTypes(ChannelType.GuildText);
    const c = baseContainer(interaction.guild, 'CHANNEL SETTINGS', 'اختر قناة نصية واحدة.');
    c.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
    return reply(interaction, componentsV2Payload(c));
  }
  if (['mainrole', 'leaderrole', 'managerrole'].includes(action)) {
    const menu = new RoleSelectMenuBuilder().setCustomId(`groups_setup_role:${action}`).setPlaceholder('اختر رولًا').setMinValues(1).setMaxValues(1);
    const c = baseContainer(interaction.guild, 'ROLE SETUP', 'اختر رولًا واحدًا.');
    c.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
    return reply(interaction, componentsV2Payload(c));
  }
  if (['textcat', 'voicecat', 'music'].includes(action)) {
    const type = action === 'textcat' || action === 'voicecat' ? ChannelType.GuildCategory : ChannelType.GuildVoice;
    const menu = new ChannelSelectMenuBuilder().setCustomId(`groups_setup_channel:${action}`).setPlaceholder('اختر قناةًا').setMinValues(1).setMaxValues(1).setChannelTypes(type);
    const c = baseContainer(interaction.guild, 'CHANNEL SETUP', 'اختر قناةًا واحدًا.');
    c.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
    return reply(interaction, componentsV2Payload(c));
  }
  if (action === 'rules') return reply(interaction, rulesPayload(interaction.guild, await gm.getRules(interaction.guild.id)));
  if (action === 'managers') return reply(interaction, managerSetupPayload(interaction.guild, settings));
  return reply(interaction, setupConfirmation(interaction, 'GROUP SETTINGS', 'تم تنفيذ إعداد القروبات.'));
}
async function handleSetupManager(interaction, action, parts = []) {
  if (action === 'remove' && interaction.isButton?.()) {
    const settings = await checkBotOwner(interaction);
    if (!settings) return true;
    return interaction.showModal(setupManagerRemovalModal());
  }
  if (!interaction.deferred && !interaction.replied) {
    if (interaction.isModalSubmit?.()) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    else await interaction.deferUpdate();
  }
  const settings = await checkBotOwner(interaction);
  if (!settings) return true;
  if (!gm.isBotOwner(interaction.client, interaction.member)) {
    return reply(interaction, { content: 'إضافة مسؤولي النظام وإزالتهم متاحة لمالكي البوت فقط.' });
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
    const updated = await saveGroupSettings(interaction.guild.id, { systemUsers, systemRoles }, interaction.user.id);
    await refreshSetupPanel(interaction, updated);
    return reply(interaction, setupConfirmation(interaction, 'SYSTEM MANAGERS', removed ? `تمت إزالة ${removed} مسؤول.` : 'لم تتطابق المعرفات مع مسؤولين محفوظين.'));
  }
  const ids = interaction.values || [];
  if (!ids.length) return reply(interaction, { content: 'اختر عضوًا أو رتبة أولًا.' });
  if (action === 'add' && parts[0] === 'user') {
    const members = await Promise.all(ids.map(id => interaction.guild.members.fetch(String(id)).catch(() => null)));
    if (members.some(member => !member || member.user?.bot)) return reply(interaction, { content: 'لا يمكن إضافة بوت أو عضو غير موجود كمسؤول نظام.' });
    const updated = await saveGroupSettings(interaction.guild.id, { systemUsers: [...new Set([...settings.systemUsers, ...ids.map(String)])] }, interaction.user.id);
    await refreshSetupPanel(interaction, updated);
    return reply(interaction, setupConfirmation(interaction, 'SYSTEM MANAGERS', `تم حفظ ${ids.length} عضو.`));
  }
  if (action === 'add' && parts[0] === 'role') {
    if (ids.some(id => String(id) === String(interaction.guild.id) || !interaction.guild.roles.cache.has(String(id)))) return reply(interaction, { content: 'لا يمكن إضافة @everyone أو رتبة غير موجودة كمسؤول نظام.' });
    const updated = await saveGroupSettings(interaction.guild.id, { systemRoles: [...new Set([...settings.systemRoles, ...ids.map(String)])] }, interaction.user.id);
    await refreshSetupPanel(interaction, updated);
    return reply(interaction, setupConfirmation(interaction, 'SYSTEM MANAGERS', `تم حفظ ${ids.length} رتبة.`));
  }
  return reply(interaction, { content: 'طلب مسؤولي النظام غير صالح.' });
}
async function handleSetupSelection(interaction, prefix, action) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  const settings = await checkBotOwner(interaction);
  if (!settings) return true;
  if (prefix === 'groups_setup_clear_select') {
    const key = String(interaction.values?.[0] || '');
    const field = CLEARABLE_SETUP_FIELDS.find(([name]) => name === key);
    if (!field) return reply(interaction, { content: 'حقل الإعداد غير صالح.' });
    const required = ['chatMode', 'textCategoryId', 'voiceCategoryId'].includes(key);
    const patch = { [key]: null };
    if (required && settings.enabled) patch.enabled = false;
    const updated = await saveGroupSettings(interaction.guild.id, patch, interaction.user.id);
    await refreshSetupPanel(interaction, updated);
    return reply(interaction, setupConfirmation(interaction, 'CLEAR', `تم مسح ${field[1]}${required && settings.enabled ? '، وأُوقف النظام حتى يكتمل الإعداد' : ''}.`));
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
    const updated = await saveGroupSettings(interaction.guild.id, patch, interaction.user.id);
    await refreshSetupPanel(interaction, updated);
    return reply(interaction, setupConfirmation(interaction, 'GROUP SETTINGS', text));
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
    const updated = await saveGroupSettings(interaction.guild.id, { [keys[action]]: roleId }, interaction.user.id);
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
    if (!channel) return reply(interaction, { content: 'القناة المحدد غير موجود في السيرفر.' });
    const categoryActions = ['textcat', 'voicecat'];
    const textActions = ['log', 'topchannel', 'adminchannel', 'memberchannel'];
    if (categoryActions.includes(action) && channel.type !== ChannelType.GuildCategory) return reply(interaction, { content: 'اختر كاتاقوري للرومات.' });
    if (action === 'music' && channel.type !== ChannelType.GuildVoice) return reply(interaction, { content: 'اختر قناةًا صوتيًا عاديًا لمصدر الموسيقى.' });
    if (textActions.includes(action) && channel.type !== ChannelType.GuildText) return reply(interaction, { content: 'اختر قناة نصية عادية.' });
    const keys = { textcat: 'textCategoryId', voicecat: 'voiceCategoryId', music: 'musicChannelId', topchannel: 'topChannelId', adminchannel: 'adminControlChannelId', memberchannel: 'memberControlChannelId', log: 'logChannelId' };
    if (!keys[action]) return reply(interaction, { content: 'نوع القناة غير صالح.' });
    const labels = { textcat: 'كاتاقوري النص', voicecat: 'كاتاقوري الصوت', music: 'مصدر الموسيقى', topchannel: 'قناة الترتيب', adminchannel: 'قناة تحكم الإدارة', memberchannel: 'قناة تحكم الأعضاء', log: 'قناة السجلات' };
    const updated = await saveGroupSettings(interaction.guild.id, { [keys[action]]: channelId }, interaction.user.id);
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
async function handleAdmin(interaction, action, page = 0) {
  if (action !== 'create' && !interaction.deferred && !interaction.replied) {
    if (String(interaction.customId || '').startsWith('groups_admin_page:')) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
  const settings = await checkSystem(interaction);
  if (!settings) return true;
  if (action === 'create') return interaction.showModal(createGroupModal(interaction.user.id));
  if (['delete', 'cleanup', 'info', 'edit', 'reset'].includes(action)) {
    const groups = (await gm.listGroups(interaction.guild.id, action === 'delete' || action === 'cleanup'))
      .filter(group => action === 'cleanup' ? group.status === 'orphaned' : group.status === 'active' || (action === 'delete' && group.status === 'orphaned'));
    if (!groups.length) return reply(interaction, { content: 'لا توجد قروبات متاحة.' });
    const pageSize = 25;
    const pageCount = Math.max(1, Math.ceil(groups.length / pageSize));
    const safePage = Math.max(0, Math.min(pageCount - 1, Number(page) || 0));
    const visible = groups.slice(safePage * pageSize, (safePage + 1) * pageSize);
    const options = visible.map(group => ({
      label: safe(group.name, 90),
      value: String(group.id),
      description: `${Number(group.points || 0).toLocaleString()} points${group.status === 'orphaned' ? ' • يحتاج تنظيف' : ''}`
    }));
    const payload = selectPayload(interaction.guild,
      action === 'delete' ? 'DELETE GROUP' : action === 'cleanup' ? 'إعادة تنظيف قروب' : action === 'reset' ? 'تصفير النقاط' : 'اختر قروبًا',
      `${action === 'cleanup' ? 'اختر قروبًا لإكمال حذفه.' : 'اختر قروبًا واحدًا.'} الصفحة ${safePage + 1}/${pageCount} • الإجمالي ${groups.length}.`,
      `groups_admin_select:${action}:${safePage}`, options);
    if (pageCount > 1) {
      const nav = [];
      if (safePage > 0) nav.push(button(`groups_admin_page:${action}:${safePage - 1}`, 'السابق'));
      if (safePage + 1 < pageCount) nav.push(button(`groups_admin_page:${action}:${safePage + 1}`, 'التالي'));
      payload.components.push(new ActionRowBuilder().addComponents(nav).toJSON());
    }
    return reply(interaction, payload);
  }
  if (action === 'resetall') {
    const c = baseContainer(interaction.guild, 'RESET ALL GROUP ACTIVITY POINTS', 'سيتم تصفير نقاط نشاط كل القروبات النشطة وعدادات الرسائل والصوت والتفاعلات. لن تتغير نقاط البونص.');
    c.addActionRowComponents(new ActionRowBuilder().addComponents(button('groups_admin_confirm:resetall', 'تأكيد', ButtonStyle.Danger), button('groups_admin_cancel', 'إلغاء')));
    return reply(interaction, componentsV2Payload(c));
  }
  return true;
}
async function handleMember(interaction, action, groupId) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const settings = await gm.getSettings(interaction.guild.id);
  let group = groupId > 0 ? await gm.getGroup(interaction.guild.id, groupId) : null;
  if (!group) {
    const groups = await gm.listGroups(interaction.guild.id);
    group = selectMemberGroup(groups, interaction.user.id, interaction.channelId);
  }
  if (!group) return reply(interaction, { content: 'لا يوجد قروب مرتبط بعضويتك في هذا السيرفر.' });
  const isSystemManager = gm.canManageSystem(interaction.client, settings, interaction.member);
  const isCurrentMember = await hasCurrentGroupMembership(interaction.guild, group, interaction.user.id);
  if (!isSystemManager && !isCurrentMember) return deny(interaction, 'هذه اللوحة متاحة لأعضاء القروب الحاليين فقط.');
  if (action === 'info') {
    const owner = await interaction.guild.members.fetch(group.owner_id).catch(() => null);
    const managers = await Promise.all(group.managerIds.map(id => interaction.guild.members.fetch(id).catch(() => null)));
    const attachment = await renderInfo({ guild: interaction.guild, group, owner, managers: managers.filter(Boolean), accentColor: null });
    return reply(interaction, { files: [attachment], allowedMentions: { parse: [] } });
  }
  return true;
}
async function handleRulesInteraction(interaction, action, parts = []) {
  if (action === 'toggle' && !interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  const settings = await checkBotOwner(interaction);
  if (!settings) return true;
  const metric = String(parts[0] || '').toLowerCase();
  const definition = RULE_METRICS.find(([key]) => key === metric);
  if (!definition) return reply(interaction, { content: 'قاعدة النقاط غير معروفة.' });
  const rules = await gm.getRules(interaction.guild.id);
  const current = rules.find(rule => String(rule.metric) === metric);
  if (action === 'edit') {
    const modal = new ModalBuilder().setCustomId(`groups_rules_modal:edit:${metric}`).setTitle('EDIT GROUP POINT RULE');
    modal.addLabelComponents(new LabelBuilder().setLabel('الحد').setTextInputComponent(new TextInputBuilder().setCustomId('threshold').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(current?.threshold || definition[3])).setPlaceholder(metric === 'voice_ms' ? 'بالمللي ثانية، مثال 3600000 = ساعة' : 'عدد الرسائل أو التفاعلات').setMaxLength(12)));
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
  const operationKey = `guild:${interaction.guild.id}:group:${groupId}:transfer-owner`;
  const operationToken = await gm.acquireOperationLock(operationKey, 120000);
  if (!operationToken) throw new Error('GROUP_OPERATION_BUSY');
  try {
  return await groupOperation(`group:${interaction.guild.id}:${groupId}`, async () => {
    const settings = await gm.getSettings(interaction.guild.id);
    const actor = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    const group = await gm.getGroup(interaction.guild.id, Number(groupId));
    if (!actor || (String(group?.owner_id) !== String(interaction.user.id) && !gm.canManageSystem(interaction.client, settings, actor))) throw new Error('OWNER_ONLY');
    const targetId = String(ownerId || '');
    if (!group || group.status !== 'active' || !group.memberIds.includes(targetId)) throw new Error('OWNER_MUST_BE_MEMBER');
    if (String(group.owner_id) === targetId) return 'العضو هو مالك القروب الحالي بالفعل.';
    const newOwner = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!newOwner || newOwner.user.bot) throw new Error('MEMBER_NOT_FOUND');
    const otherGroups = await gm.listGroups(interaction.guild.id);
    if (otherGroups.some(item => Number(item.id) !== Number(group.id) && String(item.owner_id) === targetId)) throw new Error('OWNER_ALREADY_HAS_GROUP');
    const oldOwnerId = String(group.owner_id);
    const nextManagers = group.managerIds.filter(id => id !== targetId);
    // Keep the former owner as a regular member so they can explicitly leave afterward.
    const nextMembers = [...new Set([...group.memberIds, oldOwnerId, targetId])].filter(id => id !== targetId || id === oldOwnerId);
    const nextBlocked = group.blockedIds.filter(id => id !== targetId);
    const warnings = [];
    const leader = settings.leaderRoleId && (interaction.guild.roles.cache.get(settings.leaderRoleId) || await interaction.guild.roles.fetch(settings.leaderRoleId).catch(() => null));
    if (settings.leaderRoleId && !leader) throw new Error('OWNER_ROLE_NOT_FOUND');
    const oldOwner = await interaction.guild.members.fetch(oldOwnerId).catch(() => null);
    const oldOwnerNeedsLeaderRemoval = Boolean(leader && oldOwner && !otherGroups.some(item => Number(item.id) !== Number(group.id) && String(item.owner_id) === oldOwnerId));
    const targetIsManagerElsewhere = otherGroups.some(item => Number(item.id) !== Number(group.id) && item.managerIds.includes(targetId));
    const managerRole = settings.managerRoleId && (interaction.guild.roles.cache.get(settings.managerRoleId) || await interaction.guild.roles.fetch(settings.managerRoleId).catch(() => null));
    if (settings.managerRoleId && group.managerIds.includes(targetId) && !managerRole) throw new Error('MANAGER_ROLE_NOT_FOUND');
    const targetHadLeader = Boolean(leader && newOwner.roles.cache.has(leader.id));
    const oldOwnerHadLeader = Boolean(leader && oldOwner?.roles.cache.has(leader.id));
    const targetHadManager = Boolean(managerRole && newOwner.roles.cache.has(managerRole.id));
    let targetLeaderAdded = false;
    let oldLeaderRemoved = false;
    let targetManagerRemoved = false;
    try {
      // Apply external role changes first. If one fails, the DB still describes the old owner.
      if (leader && !targetHadLeader) { await newOwner.roles.add(leader, 'TRANSFER GROUP OWNERSHIP'); targetLeaderAdded = true; }
      if (leader && oldOwnerNeedsLeaderRemoval && oldOwnerHadLeader) { await oldOwner.roles.remove(leader, 'TRANSFER GROUP OWNERSHIP'); oldLeaderRemoved = true; }
      if (managerRole && group.managerIds.includes(targetId) && !targetIsManagerElsewhere && targetHadManager) { await newOwner.roles.remove(managerRole, 'Owner promoted from group manager'); targetManagerRemoved = true; }
      await gm.updateGroup(interaction.guild.id, group.id, {
        owner_id: targetId,
        manager_ids_json: JSON.stringify(nextManagers),
        member_ids_json: JSON.stringify(nextMembers),
        blocked_ids_json: JSON.stringify(nextBlocked),
        updated_at: Date.now()
      }, interaction.user.id);
    } catch (error) {
      if (targetManagerRemoved && managerRole) await newOwner.roles.add(managerRole, 'Rollback incomplete ownership transfer').catch(() => {});
      if (oldLeaderRemoved && leader && oldOwner) await oldOwner.roles.add(leader, 'Rollback incomplete ownership transfer').catch(() => {});
      if (targetLeaderAdded && leader) await newOwner.roles.remove(leader, 'Rollback incomplete ownership transfer').catch(() => {});
      throw error;
    }
    invalidateGroupCaches(interaction.guild.id);
    if (settings.managerRoleId && group.managerIds.includes(targetId)) {
      const stillManager = (await gm.listGroups(interaction.guild.id)).some(item => item.managerIds.includes(targetId));
      if (managerRole && stillManager && !targetIsManagerElsewhere) warnings.push('بقيت رتبة مسؤول القروب لأن العضو ما زال مسؤولًا في قروب آخر');
    }
    await gm.logGroupEvent(interaction.guild, 'owner', { groupId: group.id, from: oldOwnerId, to: targetId, warnings }, interaction.user.id);
    const transferNotice = `تم نقل ملكية قروب **${safe(group.name,100)}** إليك.\n\n${groupResourceSummary({ ...group, owner_id: targetId })}`;
    await Promise.all([notifyGroupDM(interaction.guild, oldOwnerId, 'GROUP OWNERSHIP TRANSFERRED', `تم نقل ملكية قروب **${safe(group.name,100)}** إلى <@${targetId}>.`), notifyGroupDM(interaction.guild, targetId, 'YOU ARE THE NEW GROUP OWNER', transferNotice)]);
    return warnings.length ? `تم نقل الملكية، لكن يلزم مراجعة الرتب: ${warnings.join('؛ ')}.` : 'تم نقل الملكية.';
  });
  } finally {
    await gm.releaseOperationLock(operationKey, operationToken);
  }
}
function beginGroupEmojiInput(interaction, groupId) {
  const key = `${interaction.guild.id}:${interaction.user.id}:${groupId}`;
  const previous = pendingGroupEmoji.get(key);
  if (previous?.timer) clearTimeout(previous.timer);
  const timer = setTimeout(() => pendingGroupEmoji.delete(key), 2 * 60 * 1000);
  timer.unref?.();
  pendingGroupEmoji.set(key, { guildId: interaction.guild.id, channelId: interaction.channelId, groupId, userId: interaction.user.id, timer });
  return reply(interaction, { content: 'أرسل إيموجي القروب هنا الآن، أو أرسل `cancel` للإلغاء. يمكنك إرسال الإيموجي المخصص مباشرة بدون Modal.' });
}
async function handleInteraction(interaction) { const extended=await handleGroupExtensions(interaction); if(extended!==false)return extended; if(String(interaction.customId||'').startsWith('groups_member_picker:')) return handleMemberPickerInteraction(interaction); const [prefix,action,...parts]=String(interaction.customId||'').split(':'); if(prefix==='groups_our_members'){
  const groupId=Number(parts[0]); const currentPage=Number(parts[1])||0; const group=await gm.getGroup(interaction.guild.id,groupId);
  const settings=await gm.getSettings(interaction.guild.id); const member=interaction.member;
  if(!group||(!group.memberIds.includes(String(interaction.user.id))&&!group.managerIds.includes(String(interaction.user.id))&&String(group.owner_id)!==String(interaction.user.id)&&!gm.canManageSystem(interaction.client,settings,member))) return interaction.reply(responsePayload({content:'عرض الأعضاء متاح لأعضاء القروب فقط.',allowedMentions:{parse:[]},ephemeral:true}));
  const page=action==='next'?currentPage+1:action==='prev'?currentPage-1:currentPage;
  return interaction.update(responsePayload(await buildOurMembersPayload(interaction.guild,group,page)));
 }
 if(prefix==='groups_top'&&['rank','group','pick','manage','avatar','avatar-modal','refresh','leave','leave-confirm','leave-cancel','transfer','transfer-select'].includes(action))return handleTopGroupsInteraction(interaction,action,parts); if(prefix==='groups_bonus')return handleTopBonusButton(interaction,action); if(prefix==='groups_bonus_select')return handleTopBonusSelection(interaction,action,parts); if(prefix==='groups_bonus_page')return handleTopBonusPage(interaction,action,parts); if(prefix==='groups_bonus_member_select')return handleTopBonusMemberSelection(interaction,action,parts); if(prefix==='groups_bonus_modal')return handleTopBonusModal(interaction,action,parts); if(prefix==='groups_bonus_confirm')return handleTopBonusConfirm(interaction,action,parts); if(prefix==='groups_rules_modal'){if(!interaction.deferred&&!interaction.replied)await interaction.deferReply({flags:MessageFlags.Ephemeral});const metric=parts[0];const settings=await checkBotOwner(interaction);if(!settings)return true;const definition=RULE_METRICS.find(([key])=>key===metric);if(!definition)return reply(interaction,{content:'قاعدة النقاط غير معروفة.'});try{const rules=await gm.getRules(interaction.guild.id);const current=rules.find(rule=>String(rule.metric)===metric);const threshold=Number(interaction.fields.getTextInputValue('threshold'));const points=Number(interaction.fields.getTextInputValue('points'));await gm.setRule(interaction.guild.id,metric,threshold,points,Number(current?.enabled)===1,interaction.user.id);await gm.logGroupEvent(interaction.guild,'rule_update',{metric,threshold,points,enabled:Number(current?.enabled)===1},interaction.user.id);await refreshSetupPanel(interaction,settings);return reply(interaction,rulesPayload(interaction.guild,await gm.getRules(interaction.guild.id)));}catch(error){const messages={INVALID_THRESHOLD:'الحد يجب أن يكون عددًا صحيحًا أكبر من صفر ولا يتجاوز مليارًا.',INVALID_POINTS:'النقاط لكل حد يجب أن تكون عددًا صحيحًا بين 1 و1,000,000.',INVALID_METRIC:'نوع قاعدة النقاط غير معروف.'};return reply(interaction,{title:'RULE UPDATE FAILED',content:messages[error.message]||'تعذر حفظ قاعدة النقاط. تحقق من القيم وحاول مرة أخرى.'});}} if(prefix==='groups_meta_edit'){
  const field=choose(action,['name','description','emoji','color','avatar']);
  try { await currentManager(interaction, Number(parts[0])); }
  catch (error) { return reply(interaction,{content:groupError(error)}); }
  if (field === 'emoji') return beginGroupEmojiInput(interaction, Number(parts[0]));
  const modal=new ModalBuilder().setCustomId(`groups_meta_modal:submit:${Number(parts[0])}:${field}`).setTitle(field==='name'?'EDIT GROUP NAME':field==='description'?'EDIT GROUP DESCRIPTION':field==='color'?'EDIT GROUP COLOR':field==='avatar'?'EDIT GROUP AVATAR':'EDIT GROUP EMOJI');
  modal.addLabelComponents(new LabelBuilder().setLabel(field==='name'?'اسم القروب':field==='description'?'وصف القروب':field==='color'?'لون القروب':field==='avatar'?'رابط صورة أو إيموجي القروب':'إيموجي القروب').setTextInputComponent(new TextInputBuilder().setCustomId('value').setStyle(field==='description'?TextInputStyle.Paragraph:TextInputStyle.Short).setRequired(field!=='emoji'&&field!=='avatar').setMaxLength(field==='description'?500:field==='name'?80:field==='color'?7:field==='avatar'?500:10).setPlaceholder(field==='color'?'#5865F2':field==='avatar'?'رابط Discord CDN أو إيموجي مخصص، اتركه فارغًا للإزالة':'')));
  return interaction.showModal(modal);
 }
 if(prefix==='groups_meta_modal'&&action==='submit'){
  if(!interaction.deferred&&!interaction.replied)await interaction.deferReply({flags:MessageFlags.Ephemeral});
  const groupId=Number(parts[0]); const field=choose(parts[1],['name','description','emoji','color','avatar']);
  try {
    const { group }=await currentManager(interaction,groupId);
    const rawValue=interaction.fields.getTextInputValue('value').trim();
    const value=field==='avatar' ? normalizeGroupAvatar(rawValue) : field==='emoji' ? normalizeGroupEmoji(rawValue) : safe(rawValue,field==='description'?500:field==='name'?80:field==='color'?7:10).trim();
    if(field==='name') await renameGroupResources(interaction,group,'name',value);
    else {
      if(field==='color'&&!/^#[0-9a-f]{6}$/i.test(value)) throw new Error('INVALID_COLOR');
      if(field==='avatar'&&rawValue&&!value) throw new Error('INVALID_AVATAR');
      if(field==='emoji') await applyGroupEmojiRole(interaction.guild, group, value);
      if(field==='color') await applyGroupRoleColor(interaction.guild, group, value);
      await gm.updateGroup(interaction.guild.id,groupId,{[field]:value,updated_at:Date.now()},interaction.user.id);
    }
    invalidateGroupCaches(interaction.guild.id);
    await gm.logGroupEvent?.(interaction.guild,'update',{groupId,field,value},interaction.user.id);
    return reply(interaction,{content:'تم تحديث بيانات القروب.'});
  } catch (error) { return reply(interaction,{content:error.message==='INVALID_COLOR'?'استخدم لونًا بصيغة ست خانات، مثل #5865F2.':error.message==='INVALID_AVATAR'?'أرسل رابط صورة من Discord CDN أو إيموجيًا مخصصًا صالحًا.':error.message==='INVALID_EMOJI'?'تعذر تحميل الإيموجي. أرسل Custom Emoji أو إيموجيًا صالحًا.':groupError(error)}); }
 }
 if(prefix==='groups_modal'){ if(action==='create') return createFromModal(interaction); if(action==='edit'){if(!interaction.deferred&&!interaction.replied)await interaction.deferReply({flags:MessageFlags.Ephemeral});if(!await checkSystem(interaction))return true;const groupId=Number(parts[0]);const field=choose(parts[1],['name','description','color','emoji']);const group=await gm.getGroup(interaction.guild.id,groupId);if(!group||group.status!=='active')return reply(interaction,{content:'القروب غير موجود.'});const rawValue=interaction.fields.getTextInputValue('value').trim();const value=field==='emoji'?normalizeGroupEmoji(rawValue):safe(rawValue,field==='description'?500:field==='name'?80:100).trim();if(field==='name')await renameGroupResources(interaction,group,'name',value);else{if(field==='color'&&!/^#[0-9a-f]{6}$/i.test(value))return reply(interaction,{content:'استخدم لونًا بصيغة ست خانات، مثل #5865F2.'});if(field==='emoji')await applyGroupEmojiRole(interaction.guild,group,value);if(field==='color')await applyGroupRoleColor(interaction.guild,group,value);await gm.updateGroup(interaction.guild.id,groupId,{[field]:value,updated_at:Date.now()},interaction.user.id);}invalidateGroupCaches(interaction.guild.id);await gm.logGroupEvent?.(interaction.guild,'update',{groupId,field,value},interaction.user.id);return reply(interaction,{content:'تم تحديث القروب.'});} return false; } if(prefix==='groups_setup')return handleSetup(interaction,action); if(prefix==='groups_rules')return handleRulesInteraction(interaction,action,parts); if(prefix==='groups_admin')return handleAdmin(interaction,action); if(prefix==='groups_admin_page')return handleAdmin(interaction,action,Number(parts[0])||0); if(prefix==='groups_member')return handleMember(interaction,action,Number(parts[0])); if(prefix==='groups_setup_clear_select'){return handleSetupSelection(interaction,prefix,action);} if(prefix==='groups_setup_select'){return handleSetupSelection(interaction,prefix,action);} if(prefix==='groups_setup_role'){return handleSetupSelection(interaction,prefix,action);} if(prefix==='groups_setup_channel'){return handleSetupSelection(interaction,prefix,action);} if(prefix==='groups_setup_manager')return handleSetupManager(interaction,action,parts); if(prefix==='groups_admin_select'){if(!interaction.deferred&&!interaction.replied)await interaction.deferUpdate();const settings=await checkSystem(interaction);if(!settings)return true;const groupId=Number(interaction.values[0]);if(action==='reset'){const group=await gm.getGroup(interaction.guild.id,groupId);if(!group||group.status!=='active')return reply(interaction,{content:'القروب غير موجود أو غير نشط.'});const c=baseContainer(interaction.guild,'CONFIRM GROUP POINT RESET',`القروب : **${safe(group.name)}**\nسيتم تصفير نقاط نشاط القروب وعدادات الرسائل والصوت والتفاعلات. نقاط البونص لن تتغير.`);c.addActionRowComponents(new ActionRowBuilder().addComponents(button(`groups_admin_confirm:reset:${groupId}`,'تأكيد التصفير',ButtonStyle.Danger),button('groups_admin_cancel','إلغاء')));return reply(interaction,componentsV2Payload(c));}if(action==='delete'||action==='cleanup'){const group=await gm.getGroup(interaction.guild.id,groupId);if(!group)return reply(interaction,{content:'القروب غير موجود.'});const cleanup=action==='cleanup'||group.status==='orphaned';const c=baseContainer(interaction.guild,cleanup?'CONFIRM GROUP CLEANUP':'CONFIRM DELETION',`القروب : **${safe(group.name)}**\n${cleanup?'ستتم إعادة محاولة حذف الرومات والرتبة المتبقية للقروب المتعثر.':'سيتم حذف رومات ورول القروب.'}`);c.addActionRowComponents(new ActionRowBuilder().addComponents(button(`groups_admin_confirm:${cleanup?'cleanup':'delete'}:${groupId}`,'تأكيد',ButtonStyle.Danger),button('groups_admin_cancel','إلغاء')));return reply(interaction,componentsV2Payload(c));}if(action==='info'){const g=await gm.getGroup(interaction.guild.id,groupId);if(!g)return reply(interaction,{content:'القروب غير موجود.'});const owner=await interaction.guild.members.fetch(g.owner_id).catch(()=>null);const managers=await Promise.all(g.managerIds.map(id=>interaction.guild.members.fetch(id).catch(()=>null)));const memberIds=[...new Set([String(g.owner_id),...(g.memberIds||[]).map(String),...(g.managerIds||[]).map(String)].filter(Boolean))];const memberRows=await Promise.all(memberIds.map(async userId=>({...((await gm.getMemberPoints(interaction.guild.id,g.id,userId).catch(()=>null))||{}),user_id:userId})));const members=await Promise.all(memberRows.map(async row=>({...row,member:await interaction.guild.members.fetch(row.user_id).catch(()=>null)})));const overview=await renderInfo({guild:interaction.guild,group:g,owner,managers:managers.filter(Boolean),accentColor:null});const membersImage=await renderMembers({guild:interaction.guild,group:g,members,accentColor:null});return reply(interaction,{title:'GROUP OVERVIEW + MEMBERS',content:`القروب : ${safe(g.name)}\nمعلومات القروب وترتيب أعضائه حسب نقاط النشاط.`,files:[overview,membersImage]});}if(action==='edit'){return reply(interaction,selectPayload(interaction.guild,'EDIT GROUP','اختر الحقل المطلوب.',`groups_edit_field:${groupId}`,[{label:'الاسم',value:'name'},{label:'الوصف',value:'description'},{label:'اللون',value:'color'},{label:'الإيموجي',value:'emoji'},{label:'المالك',value:'owner'}]));}} if(prefix==='groups_edit_field'){const groupId=Number(action);const field=choose(interaction.values?.[0],['name','description','color','emoji','owner']);if(!await checkSystem(interaction))return true;if(field==='emoji')return beginGroupEmojiInput(interaction,groupId);if(field==='owner'){const menu=new UserSelectMenuBuilder().setCustomId(`groups_edit_owner:${groupId}`).setPlaceholder('اختر المالك الجديد').setMinValues(1).setMaxValues(1);const c=baseContainer(interaction.guild,'TRANSFER OWNERSHIP','اختر عضوًا حاليًا من القروب.');c.addActionRowComponents(new ActionRowBuilder().addComponents(menu));return reply(interaction,componentsV2Payload(c));}const modal=new ModalBuilder().setCustomId(`groups_modal:edit:${groupId}:${field}`).setTitle(`EDIT ${field.toUpperCase()}`);modal.addLabelComponents(new LabelBuilder().setLabel(field).setTextInputComponent(new TextInputBuilder().setCustomId('value').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(field==='description'?500:100)));return interaction.showModal(modal);} if(prefix==='groups_edit_owner'){if(!interaction.deferred&&!interaction.replied)await interaction.deferUpdate();if(!await checkSystem(interaction))return true;try{return reply(interaction,{content:await transferGroupOwner(interaction,Number(action),interaction.values?.[0])});}catch(error){const message=error.message==='OWNER_MUST_BE_MEMBER'?'يجب أن يكون المالك الجديد عضوًا نشطًا في القروب.':error.message==='OWNER_ALREADY_HAS_GROUP'?'المالك المختار يملك قروبًا آخر بالفعل.':'تعذر نقل الملكية.';return reply(interaction,{content:message});}} if(prefix==='groups_admin_confirm'){if(!interaction.deferred&&!interaction.replied)await interaction.deferUpdate();const settings=await checkSystem(interaction);if(!settings)return true;if(action==='reset'){const groupId=Number(parts[0]);const group=await gm.getGroup(interaction.guild.id,groupId);if(!group||group.status!=='active')return reply(interaction,{content:'القروب غير موجود أو غير نشط؛ لم يتم تصفير أي نقاط.'});await reply(interaction,{title:'RESETTING GROUP POINTS',content:'جارٍ تصفير نقاط النشاط والعدادات. انتظر حتى تكتمل العملية.',thumbnail:groupThumb(interaction.guild)});await gm.resetPoints(interaction.guild.id,groupId,interaction.user.id);const notice=`تم تصفير نقاط نشاط قروب **${safe(group.name,100)}** وعداداته. نقاط البونص لم تتغير.`;await notifyGroupParties(interaction.guild,group,interaction.user.id,'GROUP POINTS RESET',notice);return interaction.editReply(responsePayload({title:'GROUP POINTS RESET',content:notice,thumbnail:groupThumb(interaction.guild),allowedMentions:{parse:[]}}));}if(action==='resetall'){await reply(interaction,{title:'RESETTING ALL GROUP POINTS',content:'جارٍ تصفير نقاط النشاط والعدادات لجميع القروبات النشطة. انتظر حتى تكتمل العملية.',thumbnail:groupThumb(interaction.guild)});await gm.resetPoints(interaction.guild.id,null,interaction.user.id);return interaction.editReply(responsePayload({title:'ALL GROUP POINTS RESET',content:'تم تصفير نقاط نشاط جميع القروبات النشطة وعداداتها. نقاط البونص لم تتغير.',thumbnail:groupThumb(interaction.guild),allowedMentions:{parse:[]}}));}if(action==='delete'||action==='cleanup'){const deletedGroup=await gm.getGroup(interaction.guild.id,Number(parts[0]));if(!deletedGroup)return reply(interaction,{title:'GROUP NOT FOUND',content:'القروب غير موجود؛ لم يتم تنفيذ الحذف.'});await reply(interaction,{title:action==='cleanup'?'CLEANING GROUP':'DELETING GROUP',content:action==='cleanup'?'جارٍ استكمال تنظيف موارد القروب المتبقية.':'جارٍ حذف رتبة القروب وقنواته. انتظر حتى تكتمل العملية.',thumbnail:groupThumb(interaction.guild)});try{await gm.deleteGroup(interaction.guild,Number(parts[0]),interaction.user.id);}catch(error){return interaction.editReply(responsePayload({title:'GROUP DELETION INCOMPLETE',content:error.message==='GROUP_DELETE_PARTIAL'?'تعذر حذف بعض عناصر القروب؛ تم حفظ حالته للتنظيف. استخدم زر إعادة التنظيف من لوحة الإدارة مرة أخرى.':'تعذر حذف القروب؛ لم يتم تأكيد اكتمال العملية.',thumbnail:groupThumb(interaction.guild),allowedMentions:{parse:[]}}));}await gm.logGroupEvent(interaction.guild,'delete',{groupId:Number(parts[0]),name:deletedGroup?.name||null,cleanup:action==='cleanup'},interaction.user.id);const notice=action==='cleanup'?'اكتمل تنظيف موارد القروب المتبقية.':'تم حذف القروب وجميع موارده المرتبطة بنجاح.';await notifyGroupParties(interaction.guild,deletedGroup,interaction.user.id,action==='cleanup'?'GROUP CLEANUP COMPLETED':'GROUP DELETED',`${notice}\n\n**Name :** ${safe(deletedGroup.name,100)}\n**Previous Owner :** <@${deletedGroup.owner_id}>\n**Role :** <@&${deletedGroup.role_id}>\n**Voice Channel :** <#${deletedGroup.voice_channel_id}>\n**Thread :** ${deletedGroup.thread_id?`<#${deletedGroup.thread_id}>`:'غير مستخدم'}`);return interaction.editReply(responsePayload({title:action==='cleanup'?'GROUP CLEANUP COMPLETED':'GROUP DELETED SUCCESSFULLY',content:notice,thumbnail:groupThumb(interaction.guild),allowedMentions:{parse:[]}}));}} if(prefix==='groups_admin_cancel')return reply(interaction,{content:'تم الإلغاء.'}); return false; }
function createLauncherPayload(guild, customId, disabled = false) {
  const c = baseContainer(guild, 'CREATE GROUP', 'افتح النموذج وابدأ إنشاء قروب جديد.');
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
      if (!gm.canManageGroupAdmin(interaction.client, settings, interaction.member)) {
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
async function execute(message, args, { client, prefix } = {}) {
  if (!message.guild) return;
  const settings = await gm.getSettings(message.guild.id);
  const member = message.member;
  const canManage = gm.canManageGroupAdmin(client, settings, member || message.author);
  if (!canManage) return replyMessage(message, 'لا تملك صلاحية إدارة القروبات. يجب أن يعيّنك مالك البوت مسؤولًا عن نظام القروبات أولًا.');
  const sub = String(args[0] || '').toLowerCase();
  if (!sub) {
    if (!gm.isBotOwner(client, member || message.author)) return replyMessage(message, 'لوحة الإعداد متاحة لمالكي البوت فقط.');
    return sendSetupPanel(message.channel, message.guild, settings);
  }

  if (['status', 'diagnose', 'تشخيص', 'حالة'].includes(sub)) {
    if (!canManage) return replyMessage(message, 'هذا التقرير متاح لمسؤولي نظام القروبات فقط.');
    const [groups, linkedGroup] = await Promise.all([
      gm.listGroups(message.guild.id, true),
      gm.getGroupForChannel(message.guild.id, message.channel.id).catch(() => null)
    ]);
    const active = groups.filter(group => group.status === 'active').length;
    const database = require('../utils/database').dbManager;
    const dispatcherLoaded = typeof module.exports.handleInternalMessage === 'function';
    const lines = [
      `Command dispatcher : ${dispatcherLoaded ? 'Loaded' : 'Unavailable'}`,
      `Database : ${database?.isInitialized ? (database.isDegraded ? 'Degraded' : 'Ready') : 'Not initialized'}`,
      `Group system : ${settings.enabled ? 'Enabled' : 'Disabled'}`,
      `Active groups : ${active}`,
      `This channel : ${linkedGroup ? `Linked to group #${linkedGroup.id} (${safe(linkedGroup.name, 60)})` : 'Not linked to an active group'}`,
      `Message prefix : ${String(prefix ?? ':')}`,
      `Next step : ${!dispatcherLoaded ? 'Restart/redeploy the current bot build.' : !database?.isInitialized || database?.isDegraded ? 'Check database startup logs and persistent storage.' : !settings.enabled ? 'Enable the group system from setup.' : 'If commands still do not respond, inspect bot.js messageCreate logs and confirm the running deployment contains this commit.'}`
    ];
    const payload = baseContainer(message.guild, 'GROUP SYSTEM DIAGNOSTICS', lines.join('\\n'));
    return message.channel.send({ ...componentsV2Payload(payload), allowedMentions: { parse: [] } });
  }

  if (sub === 'setup' || sub === 'إعدادات') {
    if (!gm.isBotOwner(client, member || message.author)) return replyMessage(message,'إعداد النظام متاح لمالكي البوت فقط.');
    return sendSetupPanel(message.channel, message.guild, settings);
  }
  if (sub === 'control' || sub === 'تحكم') {
    if (!canManage) return replyMessage(message,'لا تملك الصلاحية.');
    const target = settings.adminControlChannelId && message.guild.channels.cache.get(settings.adminControlChannelId);
    return sendAdminControlPanel(target || message.channel, message.guild);
  }
  if (['rules', 'قواعد'].includes(sub)) {
    if (!canManage) return replyMessage(message,'لا تملك الصلاحية.');
    if (!gm.isBotOwner(client, member || message.author)) return replyMessage(message,'تعديل إعدادات القواعد متاح لمالكي البوت فقط.');
    if (!args[1]) return message.channel.send(rulesPayload(message.guild, await gm.getRules(message.guild.id)));
    const metricName = String(args[1]).toLowerCase();
    const metric = metricName === 'voice' ? 'voice_ms' : ['reaction', 'reactions'].includes(metricName) ? 'reactions' : 'messages';
    const threshold = Number(args[2] || 100);
    const points = Number(args[3] || 1);
    await gm.setRule(message.guild.id, metric, threshold, points, true, message.author.id);
    await gm.logGroupEvent(message.guild, 'rule_update', { metric, threshold, points, enabled: true }, message.author.id);
    return replyMessage(message,`تم حفظ القاعدة : ${metric} / ${threshold} / ${points}`);
  }
  if (['minlength', 'حد_الرسالة', 'طول_الرسالة'].includes(sub)) {
    if (!canManage) return replyMessage(message, 'لا تملك الصلاحية.');
    if (!gm.isBotOwner(client, member || message.author)) return replyMessage(message, 'تعديل إعدادات النظام متاح لمالكي البوت فقط.');
    if (args[1] == null) return replyMessage(message, `الحد الأدنى الحالي لطول الرسالة : ${Number(settings.minMessageLength) || 0} حرف. استخدم groups minlength 0 لإيقاف الشرط، أو رقمًا من 1 إلى 2000.`);
    const value = Number(args[1]);
    if (!Number.isInteger(value) || value < 0 || value > 2000) return replyMessage(message, 'اكتب رقمًا صحيحًا من 0 إلى 2000. القيمة 0 تعطل الحد الأدنى.');
    const updated = await saveGroupSettings(message.guild.id, { minMessageLength: value }, message.author.id);
    settingsCache.delete(String(message.guild.id));
    await gm.audit(message.guild.id, message.author.id, null, 'minimum_message_length_update', { before: settings.minMessageLength, after: updated.minMessageLength }).catch(() => {});
    return replyMessage(message, `تم تحديث الحد الأدنى لطول الرسالة : ${updated.minMessageLength} حرف.`);
  }
  if (['reconcile', 'مصالحة', 'مزامنة_فحص'].includes(sub)) {
    if (!canManage) return replyMessage(message, 'لا تملك الصلاحية.');
    const result = await reconcileGroupMembership(message.guild, message.author.id);
    const lines = result.issues.slice(0, 25).map(issue => `• Group ${issue.groupId} (${safe(issue.groupName, 60)}) — ${issue.detail}${issue.userId ? ` <@${issue.userId}>` : ''}`);
    const summary = `تم فحص ${result.groups} قروب. عدد حالات الاختلاف : ${result.issues.length}. لم يتم تعديل الرتب أو العضويات تلقائيًا.\n\n${lines.join('\n') || 'لم يتم العثور على اختلافات.'}`;
    return message.channel.send({ ...componentsV2Payload(baseContainer(message.guild, 'MEMBERSHIP RECONCILIATION', summary.slice(0, 3800))), allowedMentions: { parse: [] } });
  }
  if (['ledger', 'سجل_النقاط', 'points-audit'].includes(sub)) {
    if (!canManage) return replyMessage(message, 'لا تملك الصلاحية.');
    const groupId = args[1] && /^\d+$/.test(args[1]) ? Number(args[1]) : null;
    const rows = await gm.listPointsLedger(message.guild.id, { groupId, limit: 15 });
    const lines = rows.map(row => `#${row.id} • Group ${row.group_id} • <@${row.user_id}> • ${row.metric} • ${Number(row.points_delta) >= 0 ? '+' : ''}${Number(row.points_delta)} • ${row.reason}`);
    const payload = baseContainer(message.guild, 'POINTS AUDIT', lines.length ? lines.join('\n').slice(0, 3800) : 'لا توجد سجلات نقاط بعد.');
    return message.channel.send({ ...componentsV2Payload(payload), allowedMentions: { parse: [] } });
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

    const pageSize = 25;
    const pageCount = Math.max(1, Math.ceil(choices.length / pageSize));
    const options = choices.slice(0, pageSize).map(group => ({
      label: safe(group.name || `Group ${group.id}`, 90),
      value: String(group.id),
      description: `${Number(group.points || 0).toLocaleString()} points${group.status === 'orphaned' ? ' • يحتاج تنظيف' : ''}`.slice(0, 100)
    }));
    const payload = selectPayload(
      message.guild,
      'DELETE GROUP',
      `اختر القروب المطلوب. الصفحة 1/${pageCount} • الإجمالي ${choices.length}. ستظهر خطوة تأكيد قبل الحذف.`,
      'groups_admin_select:delete:0',
      options
    );
    if (pageCount > 1) payload.components.push(new ActionRowBuilder().addComponents(
      button('groups_admin_page:delete:1', 'التالي')
    ).toJSON());
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
    return message.channel.send({ files: [await renderMembers({ guild: message.guild, group: full, members, accentColor: null })], allowedMentions: { parse: [] } });
  }
  return replyMessage(message,'استخدم أمر القروبات مع الخيارات: setup، control، create، delete، top، members أو rules.');
}
const activityCache=new Map(); const settingsCache=new Map(); const voiceStarts=new Map(); const voiceChannels=new Map(); const lastMessageAt=new Map(); const lastSkipAuditAt=new Map();
const reconciliationSignatures = new Map();
const reconciliationLocks = new Map();
const reconciliationCursors = new Map();
const pendingRoleGuardChecks = new Map();
function isAllowedGroupVoiceMember(group, member, channel = null) {
  const userId = String(member?.id || member?.user?.id || '');
  if (!userId || group.blockedIds.includes(userId)) return false;
  if ([String(group.owner_id), ...group.memberIds, ...group.managerIds].includes(userId)) return true;
  const overwrite = channel?.permissionOverwrites?.cache?.get?.(userId);
  return Boolean(overwrite?.allow?.has?.(PermissionsBitField.Flags.Connect) && !overwrite?.deny?.has?.(PermissionsBitField.Flags.Connect));
}
async function reconcileGroupMembershipUnlocked(guild, actorId = null) {
  let allGroups = (await gm.listGroups(guild.id, true)).filter(group => group.status !== 'deleted');
  const cursorKey = String(guild.id);
  const start = allGroups.length ? Number(reconciliationCursors.get(cursorKey) || 0) % allGroups.length : 0;
  let groups = allGroups.length > 25 ? [...allGroups.slice(start), ...allGroups.slice(0, start)].slice(0, 25) : allGroups;
  if (allGroups.length) reconciliationCursors.set(cursorKey, (start + groups.length) % allGroups.length);
  const issues = [];
  const botCache = new Map();
  const settings = await gm.getSettings(guild.id);
  await consolidateThreadGroupChats(guild, settings, allGroups).catch(error => {
    console.error('[groups] shared group-chat consolidation failed:', guild.id, error?.message || error);
  });
  allGroups = (await gm.listGroups(guild.id, true)).filter(group => group.status !== 'deleted');
  groups = allGroups.length > 25 ? [...allGroups.slice(start), ...allGroups.slice(0, start)].slice(0, 25) : allGroups;
  const isBotId = async userId => {
    const id = String(userId);
    if (botCache.has(id)) return botCache.get(id);
    const cached = guild.members.cache.get(id);
    if (cached) { const result = Boolean(cached.user?.bot); botCache.set(id, result); return result; }
    const fetched = await guild.members.fetch(id).catch(() => null);
    const result = Boolean(fetched?.user?.bot);
    botCache.set(id, result);
    return result;
  };
  for (const originalGroup of groups) {
    let group = originalGroup;
    const roleState = await reconcileFetch(guild.roles, group.role_id);
    const textState = await reconcileFetch(guild.channels, group.text_channel_id);
    const voiceState = await reconcileFetch(guild.channels, group.voice_channel_id);
    const threadState = await reconcileFetch(guild.channels, group.thread_id);
    const resourceRole = roleState.value;
    const resourceText = textState.value;
    const resourceVoice = voiceState.value;
    const resourceThread = threadState.value;
    const temporaryFetchError = [roleState.error, textState.error, voiceState.error, threadState.error].find(error => error && retryableDiscordError(error));
    if (temporaryFetchError) {
      await gm.runtimeLog(guild.id, group.id, 'reconciliation_fetch', 'warning', { message: String(temporaryFetchError.message || temporaryFetchError).slice(0, 300) }).catch(() => {});
      continue;
    }
    const unexpectedFetchError = [roleState.error, textState.error, voiceState.error, threadState.error].find(error => error && ![10003, 10007].includes(Number(error.code)));
    if (unexpectedFetchError) {
      await gm.runtimeLog(guild.id, group.id, 'reconciliation_fetch', 'warning', { code: unexpectedFetchError.code || null, message: String(unexpectedFetchError.message || unexpectedFetchError).slice(0, 300) }).catch(() => {});
      continue;
    }
    const missingResource = !resourceRole || !resourceText || resourceText.type !== ChannelType.GuildText || !resourceVoice || resourceVoice.type !== ChannelType.GuildVoice || (settings.chatMode === 'threads' && (!resourceThread || !resourceThread.isThread?.()));
    if (missingResource && group.status === 'active') {
      await gm.audit(guild.id, actorId, group.id, 'group_resource_drift_detected', { roleMissing: !resourceRole, textMissing: !resourceText, threadMissing: settings.chatMode === 'threads' && !resourceThread, voiceMissing: !resourceVoice }).catch(() => {});
      await restoreGroupResources(guild, group, 'reconcile_missing_resource').catch(error => console.error('[groups] resource reconciliation failed:', guild.id, group.id, error?.message || error));
      continue;
    }
    const settingsDrift = [];
    if (resourceText && settings.textCategoryId && String(resourceText.parentId || '') !== String(settings.textCategoryId)) settingsDrift.push('text_category');
    if (resourceVoice && settings.voiceCategoryId && String(resourceVoice.parentId || '') !== String(settings.voiceCategoryId)) settingsDrift.push('voice_category');
    if (settingsDrift.length) {
      await gm.runtimeLog(guild.id, group.id, 'settings_drift', 'warning', { fields: settingsDrift }).catch(() => {});
      issues.push({ groupId: group.id, groupName: group.name, type: 'settings_drift', detail: `الموارد لا تطابق إعدادات الكاتاقوري: ${settingsDrift.join(', ')}` });
    }
    let expected = [...new Set([String(group.owner_id), ...group.memberIds, ...group.managerIds].filter(Boolean))];
    const role = group.role_id ? (guild.roles.cache.get(String(group.role_id)) || await guild.roles.fetch(String(group.role_id)).catch(() => null)) : null;
    if (!role) {
      issues.push({ groupId: group.id, groupName: group.name, type: 'role_missing', detail: 'رتبة القروب غير موجودة أو لا يمكن الوصول إليها.' });
    } else {
      if (resourceText?.permissionOverwrites) {
        await resourceText.permissionOverwrites.edit(role.id, {
          ViewChannel: true, SendMessages: true, SendMessagesInThreads: true, ReadMessageHistory: true
        }, { reason: 'Synchronize managed group text permissions' }).catch(error => {
          issues.push({ groupId: group.id, groupName: group.name, type: 'text_permissions_sync_failed', detail: String(error?.message || error).slice(0, 200) });
        });
      }
      if (resourceVoice?.permissionOverwrites) {
        await resourceVoice.permissionOverwrites.edit(guild.roles.everyone.id, {
          ViewChannel: true, Connect: false
        }, { reason: 'Synchronize public voice visibility and private connect' }).catch(error => {
          issues.push({ groupId: group.id, groupName: group.name, type: 'voice_public_permissions_sync_failed', detail: String(error?.message || error).slice(0, 200) });
        });
        await resourceVoice.permissionOverwrites.edit(role.id, {
          ViewChannel: true, Connect: true, Speak: true, Stream: true, UseVAD: true
        }, { reason: 'Synchronize managed group voice permissions' }).catch(error => {
          issues.push({ groupId: group.id, groupName: group.name, type: 'voice_permissions_sync_failed', detail: String(error?.message || error).slice(0, 200) });
        });
        const unauthorized = [...(resourceVoice.members?.values?.() || [])].filter(member => !member.user?.bot && !isAllowedGroupVoiceMember(group, member, resourceVoice));
        await runWithConcurrency(unauthorized, 4, async member => {
          await member.voice?.disconnect?.(`Unauthorized entry to group voice ${group.id}`).catch(error => {
            issues.push({ groupId: group.id, groupName: group.name, type: 'voice_unauthorized_disconnect_failed', userId: member.id, detail: String(error?.message || error).slice(0, 200) });
          });
        });
      }
      for (const userId of expected) {
        if (await isBotId(userId)) continue;
        let member = guild.members.cache.get(userId) || null;
        if (!member && !role.members.has(userId)) member = await guild.members.fetch(userId).catch(() => null);
        if (member && !member.roles.cache.has(role.id)) {
          issues.push({ groupId: group.id, groupName: group.name, type: 'member_missing_role', userId, detail: 'عضو محفوظ في قاعدة البيانات ولا يحمل رتبة القروب.' });
          if (role.editable) await member.roles.add(role, 'Repair managed group membership').catch(error => console.warn('[groups] membership role repair failed:', userId, error?.message || error));
        }
        else if (!member && !role.members.has(userId)) issues.push({ groupId: group.id, groupName: group.name, type: 'member_not_found', userId, detail: 'العضو محفوظ في قاعدة البيانات لكنه غير موجود أو تعذر جلبه من السيرفر.' });
      }
      for (const [userId] of role.members) {
        if (await isBotId(userId)) continue;
        if (!expected.includes(String(userId))) issues.push({ groupId: group.id, groupName: group.name, type: 'role_member_not_in_db', userId, detail: 'عضو يحمل رتبة القروب لكنه غير موجود في قائمة العضوية المحفوظة.' });
      }
      // Database membership is authoritative. Discord role caches can lag or be
      // incomplete, so never remove a saved member or silently enroll a role
      // holder during reconciliation. Missing roles are repaired above; explicit
      // leave/block actions are responsible for removals.
      const roleMemberIds = new Set([...role.members.keys()].map(String));
      for (const userId of roleMemberIds) {
        if (await isBotId(userId)) continue;
        if (!expected.includes(userId) && !group.blockedIds.includes(userId)) {
          issues.push({ groupId: group.id, groupName: group.name, type: 'role_member_not_in_db', userId, detail: 'عضو يحمل رتبة القروب لكنه غير موجود في قائمة العضوية المحفوظة؛ تم إبقاء الرتبة لحين التحقق الآمن.' });
        }
      }
    }
    if (group.thread_id) {
      const thread = guild.channels.cache.get(String(group.thread_id)) || await guild.channels.fetch(String(group.thread_id)).catch(() => null);
      if (!thread || typeof thread.members?.fetch !== 'function') {
        issues.push({ groupId: group.id, groupName: group.name, type: 'thread_missing', detail: 'ثريد القروب غير موجود أو تعذر قراءة أعضائه.' });
      } else {
        const threadMembers = await thread.members.fetch().catch(() => null);
        if (!threadMembers) {
          issues.push({ groupId: group.id, groupName: group.name, type: 'thread_members_unavailable', detail: 'تعذر جلب عضوية الثريد؛ لم يتم إجراء أي تعديل تلقائي.' });
        } else {
          const actual = new Set();
          for (const [userId, threadMember] of threadMembers) if (!(threadMember?.user?.bot) && !(await isBotId(userId))) actual.add(String(userId));
          for (const userId of expected) if (!(await isBotId(userId)) && !actual.has(userId)) issues.push({ groupId: group.id, groupName: group.name, type: 'member_missing_thread', userId, detail: 'عضو محفوظ في قاعدة البيانات لكنه ليس عضوًا في الثريد.' });
          const missingThreadMembers = expected.filter(userId => !actual.has(userId));
          await runWithConcurrency(missingThreadMembers, 4, async userId => {
            if (!(await restoreThreadMember(thread, userId))) await gm.audit(guild.id, actorId, group.id, 'group_thread_member_repair_failed', { userId }).catch(() => {});
          });
          const extraThreadMembers = [...actual].filter(userId => group.blockedIds.includes(userId));
          for (const userId of extraThreadMembers) issues.push({ groupId: group.id, groupName: group.name, type: 'thread_member_not_in_db', userId, detail: 'عضو في الثريد غير موجود في قائمة العضوية المحفوظة.' });
          await runWithConcurrency(extraThreadMembers, 4, async userId => {
            try { await withDiscordRetry(() => thread.members.remove(userId), 3); }
            catch (error) { await gm.audit(guild.id, actorId, group.id, 'group_thread_member_remove_failed', { userId, message: String(error?.message || error).slice(0, 200) }).catch(() => {}); }
          });
        }
      }
    }
  }
  const byGroup = new Map();
  for (const issue of issues) {
    const key = String(issue.groupId);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(issue);
  }
  for (const group of groups) {
    const groupIssues = byGroup.get(String(group.id)) || [];
    const signature = JSON.stringify(groupIssues.map(({ type, userId }) => [type, userId || null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    const key = `${guild.id}:${group.id}`;
    if (reconciliationSignatures.get(key) !== signature) {
      reconciliationSignatures.set(key, signature);
      if (groupIssues.length) {
        await gm.audit(guild.id, actorId, group.id, 'membership_reconciliation_drift', { issueCount: groupIssues.length, issues: groupIssues.slice(0, 50) }).catch(() => {});
        await gm.logGroupEvent(guild, 'update', { groupId: group.id, reason: 'membership_reconciliation_drift', issueCount: groupIssues.length, issues: groupIssues.slice(0, 10) }, actorId).catch(() => {});
      } else if (reconciliationSignatures.has(key)) {
        await gm.audit(guild.id, actorId, group.id, 'membership_reconciliation_clean', { resolved: true }).catch(() => {});
      }
    }
  }
  for (const group of groups.filter(item => item.status === 'orphaned')) {
    const key = `${guild.id}:${group.id}`;
    const now = Date.now();
    if (now - Number(group.updated_at || 0) < 5 * 60 * 1000 || now < Number(orphanCleanupNextAt.get(key) || 0)) continue;
    orphanCleanupNextAt.set(key, now + 10 * 60 * 1000);
    await gm.deleteGroup(guild, group.id, actorId).then(() => orphanCleanupNextAt.delete(key)).catch(error => {
      console.warn('[groups] orphaned group cleanup retry failed:', guild.id, group.id, error?.message || error);
    });
  }
  return { groups: groups.length, issues };
}
async function reconcileGroupMembership(guild, actorId = null) {
  const key = String(guild.id);
  if (reconciliationLocks.has(key)) return { skipped: true, reason: 'RECONCILIATION_LOCKED' };
  const work = reconcileGroupMembershipUnlocked(guild, actorId);
  reconciliationLocks.set(key, work);
  try { return await work; } finally { if (reconciliationLocks.get(key) === work) reconciliationLocks.delete(key); }
}

async function cachedGroups(guildId){const hit=activityCache.get(String(guildId));if(hit&&Date.now()-hit.at<30000)return hit.groups;const groups=await gm.listGroups(guildId);activityCache.set(String(guildId),{at:Date.now(),groups});return groups;}
async function cachedSettings(guildId){const hit=settingsCache.get(String(guildId));if(hit&&Date.now()-hit.at<30000)return hit.settings;const settings=await gm.getSettings(guildId);settingsCache.set(String(guildId),{at:Date.now(),settings});return settings;}
function pruneRuntimeCaches(client) {
  const guildIds = new Set([...client.guilds.cache.keys()].map(String));
  const keepGuildKey = key => guildIds.has(String(key).split(':')[0]);
  for (const map of [activityCache, settingsCache, reconciliationSignatures, reconciliationCursors, topPanelLocks, topPanelRefreshTimers, topPanelRefreshChannels, topPanelMessageIds]) {
    for (const key of map.keys()) if (!keepGuildKey(key)) map.delete(key);
  }
  for (const map of [voiceStarts, voiceChannels, lastMessageAt, lastSkipAuditAt]) {
    for (const key of map.keys()) if (!keepGuildKey(key)) map.delete(key);
  }
  for (const [key, timer] of pendingRoleGuardChecks) {
    if (!keepGuildKey(key)) { clearTimeout(timer); pendingRoleGuardChecks.delete(key); }
  }
}
async function logActivitySkip(guildId, userId, groupId, metric, reason, details = {}) {
  const now = Date.now();
  const key = `${guildId}:${userId}:${metric}:${reason}`;
  if (now - Number(lastSkipAuditAt.get(key) || 0) < 5 * 60 * 1000) return;
  lastSkipAuditAt.set(key, now);
  if (lastSkipAuditAt.size > 5000) for (const [entry, time] of lastSkipAuditAt) if (now - time > 60 * 60 * 1000) lastSkipAuditAt.delete(entry);
  await gm.audit(guildId, userId, groupId, 'activity_skipped', { metric, reason, ...details }).catch(error => console.error('[groups] activity diagnostic audit failed:', error?.message || error));
}
function registerInteractionHandler(client) {
  if (registered) return;
  registered = true;
  router.register('groups_', handleInteraction, { name: 'groups', priority: 95, types: ['button', 'modal', 'stringSelect', 'userSelect', 'roleSelect', 'channelSelect'] });

  // Never bulk-delete ordinary messages here. A previous heuristic removed every
  // non-bot message without components, which destroyed normal group conversations.
  // Restore persisted voice sessions after a restart. Recovery is capped at two minutes
  // so downtime never creates a large artificial voice-point award.
  const restoreVoiceSessions = async () => {
    const sessions = await gm.listVoiceSessions();
    const now = Date.now();
    for (const session of sessions) {
      const guild = client.guilds.cache.get(String(session.guild_id));
      if (!guild) continue;
      const member = guild.members.cache.get(String(session.user_id))
        || await guild.members.fetch(String(session.user_id)).catch(() => null);
      if (!member) {
        await gm.deleteVoiceSession(session.guild_id, session.user_id).catch(() => {});
        continue;
      }
      if (member.voice?.channelId !== String(session.channel_id)) {
        await gm.deleteVoiceSession(session.guild_id, session.user_id).catch(() => {});
        continue;
      }
      const [groups, settings] = await Promise.all([cachedGroups(guild.id), cachedSettings(guild.id).catch(() => null)]);
      const eligibleGroup = groups.find(group =>
        (group.memberIds.includes(String(session.user_id)) || String(group.owner_id) === String(session.user_id) || group.managerIds.includes(String(session.user_id)))
        && (settings?.countAllChannels || group.voice_channel_id === String(session.channel_id))
      );
      if (!eligibleGroup) { await gm.deleteVoiceSession(session.guild_id, session.user_id).catch(() => {}); continue; }
      voiceStarts.set(`${session.guild_id}:${session.user_id}`, Math.max(now - 120000, Number(session.checkpoint_at) || now));
      voiceChannels.set(`${session.guild_id}:${session.user_id}`, String(session.channel_id));
    }
  };
  if (client.isReady?.()) restoreVoiceSessions().catch(error => console.error('[groups] voice session restore failed:', error?.message || error));
  else client.once('ready', () => restoreVoiceSessions().catch(error => console.error('[groups] voice session restore failed:', error?.message || error)));

  const startReconciliation = () => {
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        // Process one guild at a time to avoid bursting member/thread fetches
        // for every guild simultaneously on large bot installations.
        for (const guild of client.guilds.cache.values()) {
          await reconcileGroupMembership(guild).catch(error => console.error('[groups] membership reconciliation failed:', error?.message || error));
        }
      } finally {
        running = false;
        pruneRuntimeCaches(client);
      }
    };
    run().catch(error => console.error('[groups] membership reconciliation run failed:', error?.message || error));
    const timer = setInterval(run, 15 * 60 * 1000);
    timer.unref?.();
  };
  if (client.isReady?.()) startReconciliation();
  else client.once('ready', startReconciliation);

  // Rebuild the persisted top-board message after every bot restart. The
  // refresh timer is in-memory, so without this bootstrap a board can remain
  // stale indefinitely until someone manually runs the top command again.
  const startTopBoardRefresh = () => {
    refreshConfiguredTopBoards(client).catch(error => {
      console.error('[groups] top-board startup refresh failed:', error?.message || error);
    });
  };
  if (client.isReady?.()) startTopBoardRefresh();
  else client.once('ready', startTopBoardRefresh);

  const voiceCheckpoint = setInterval(async () => {
    const now = Date.now();
    for (const [key, started] of voiceStarts) {
      const [guildId, userId] = key.split(':');
      const channelId = voiceChannels.get(key);
      if (!channelId) continue;
      const elapsed = Math.min(120000, Math.max(0, now - Number(started)));
      if (elapsed > 0) await gm.recordActivity(guildId, userId, 'voice_ms', elapsed, channelId, `voice-checkpoint:${userId}:${Number(started)}:${now}`).catch(error => console.error('[groups] voice checkpoint failed:', error?.message || error));
      voiceStarts.set(key, now);
      await gm.upsertVoiceSession(guildId, userId, channelId, now).catch(error => console.error('[groups] voice checkpoint save failed:', error?.message || error));
    }
  }, 60000);
  voiceCheckpoint.unref?.();

  client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;
    const pendingKey = `${message.guild.id}:${message.author.id}:${[...pendingGroupEmoji.values()].find(item => item.guildId === message.guild.id && item.userId === message.author.id && item.channelId === message.channelId)?.groupId || ''}`;
    const pending = pendingGroupEmoji.get(pendingKey);
    if (pending && pending.channelId === message.channelId) {
      pendingGroupEmoji.delete(pendingKey);
      if (pending.timer) clearTimeout(pending.timer);
      const rawValue = String(message.content || '').trim();
      if (rawValue.toLowerCase() === 'cancel') return message.reply('تم إلغاء تعديل إيموجي القروب.').catch(() => null);
      const hasEmoji = parseCustomEmoji(rawValue) || parseEmojiId(rawValue) || extractFirstEmoji(rawValue);
      const value = normalizeGroupEmoji(rawValue);
      if (!hasEmoji || !value) return message.reply('لم أتعرف على الإيموجي. أرسل Custom Emoji أو إيموجي عادي صالحًا.').catch(() => null);
      const group = await gm.getGroup(message.guild.id, pending.groupId).catch(() => null);
      const settingsForEmoji = await gm.getSettings(message.guild.id).catch(() => null);
      if (!group || !gm.canManageGroup(message.client, settingsForEmoji, group, message.member)) return message.reply('لم تعد تملك صلاحية تعديل هذا القروب.').catch(() => null);
      try { await applyGroupEmojiRole(message.guild, group, value); }
      catch (error) {
        const messageText = error.message === 'INVALID_EMOJI' ? 'تعذر تحميل الإيموجي.'
          : error.message === 'MISSING_MANAGE_ROLES' ? 'البوت لا يملك Manage Roles.'
            : error.message === 'GROUP_ROLE_NOT_EDITABLE' ? 'رتبة القروب غير قابلة للتعديل؛ ارفع رتبة البوت فوقها.'
              : 'رفض Discord تحديث أيقونة رتبة القروب.';
        return message.reply(messageText).catch(() => null);
      }
      await gm.updateGroup(message.guild.id, pending.groupId, { emoji: value, updated_at: Date.now() }, message.author.id);
      invalidateGroupCaches(message.guild.id);
      await gm.logGroupEvent?.(message.guild, 'update', { groupId: pending.groupId, field: 'emoji', value }, message.author.id);
      await message.delete().catch(() => null);
      return message.reply(`تم تحديث إيموجي القروب إلى ${value}.`).catch(() => null);
    }
    const settings = await cachedSettings(message.guild.id).catch(() => null);
    if (!settings?.enabled) return;
    const groups = await cachedGroups(message.guild.id);
    const userId = String(message.author.id);
    const eligible = groups.some(group =>
      (group.memberIds.includes(userId) || String(group.owner_id) === userId || group.managerIds.includes(userId))
      && (settings.countAllChannels || gm.channelBelongs(group, message.channelId))
    );
    if (!eligible) {
      const isMember = groups.some(group => group.memberIds.includes(userId) || String(group.owner_id) === userId || group.managerIds.includes(userId));
      await logActivitySkip(message.guild.id, userId, null, 'messages', isMember ? 'channel_out_of_scope' : 'member_not_eligible', { channelId: message.channelId });
      return;
    }
    const minLength = Math.max(0, Number(settings.minMessageLength) || 0);
    if (minLength > 0 && Array.from(String(message.content || '').trim()).length < minLength) {
      await logActivitySkip(message.guild.id, userId, null, 'messages', 'below_minimum_length', { minimum: minLength, actual: Array.from(String(message.content || '').trim()).length, channelId: message.channelId });
      return;
    }
    // One message award per user per guild per minute prevents farming across multiple channels.
    const key = `${message.guild.id}:${userId}`;
    const now = Date.now();
    if (now - Number(lastMessageAt.get(key) || 0) < 60000) {
      await logActivitySkip(message.guild.id, userId, null, 'messages', 'cooldown_active', { channelId: message.channelId, cooldownMs: 60000 });
      return;
    }
    lastMessageAt.set(key, now);
    if (lastMessageAt.size > 10000) for (const [entry, time] of lastMessageAt) if (now - time > 600000) lastMessageAt.delete(entry);
    const awarded = await gm.recordActivity(message.guild.id, userId, 'messages', 1, message.channelId, message.id).catch(error => { console.error('[groups] message points failed:', error?.message || error); return 0; });
    if (!awarded) {
      const diagnosis = await gm.explainActivity(message.guild.id, userId, 'messages', message.channelId, 1).catch(() => null);
      if (diagnosis && diagnosis.reason !== 'eligible') await logActivitySkip(message.guild.id, userId, null, 'messages', diagnosis.reason, diagnosis);
    }
  });

  client.on('messageReactionAdd', async (reaction, user) => {
    if (!user || user.bot) return;
    const sourceMessage = reaction?.message?.partial
      ? await reaction.message.fetch().catch(() => null)
      : reaction?.message;
    const guild = sourceMessage?.guild;
    if (!sourceMessage || !guild) return;
    // Self-reactions do not generate group points.
    if (String(sourceMessage.author?.id || '') === String(user.id)) return;
    const settings = await cachedSettings(guild.id).catch(() => null);
    if (!settings?.enabled) return;
    const groups = await cachedGroups(guild.id);
    const eligible = groups.some(group =>
      (group.memberIds.includes(String(user.id)) || String(group.owner_id) === String(user.id) || group.managerIds.includes(String(user.id)))
      && (settings.countAllChannels || gm.channelBelongs(group, sourceMessage.channelId))
    );
    if (!eligible) {
      const isMember = groups.some(group => group.memberIds.includes(String(user.id)) || String(group.owner_id) === String(user.id) || group.managerIds.includes(String(user.id)));
      await logActivitySkip(guild.id, user.id, null, 'reactions', isMember ? 'channel_out_of_scope' : 'member_not_eligible', { channelId: sourceMessage.channelId, messageId: sourceMessage.id }).catch(() => {});
      return;
    }
    const emojiKey = reaction.emoji?.id || reaction.emoji?.name || 'unknown';
    const eventId = `${sourceMessage.id}:${emojiKey}`;
    const awarded = await gm.recordActivity(guild.id, user.id, 'reactions', 1, sourceMessage.channelId, eventId).catch(error => { console.error('[groups] reaction points failed:', error?.message || error); return 0; });
    if (!awarded) {
      const diagnosis = await gm.explainActivity(guild.id, user.id, 'reactions', sourceMessage.channelId, 1).catch(() => null);
      if (diagnosis && diagnosis.reason !== 'eligible') await logActivitySkip(guild.id, user.id, null, 'reactions', diagnosis.reason, { ...diagnosis, channelId: sourceMessage.channelId, messageId: sourceMessage.id }).catch(() => {});
    }
  });

  client.on('voiceStateUpdate', async (oldState, newState) => {
    const guildId = newState.guild?.id || oldState.guild?.id;
    if (!guildId) return;
    const [groups, settings] = await Promise.all([
      cachedGroups(guildId),
      cachedSettings(guildId).catch(() => null)
    ]);
    const memberId = String(newState.id || oldState.id);
    const eventMember = newState.member || await newState.guild?.members?.fetch(memberId).catch(() => null);
    const enteredGroupVoice = newState.channelId && groups.find(group => String(group.voice_channel_id) === String(newState.channelId));
    const enteredChannel = newState.channel || newState.guild?.channels?.cache?.get?.(String(newState.channelId)) || await channelById(newState.guild, newState.channelId);
    if (enteredGroupVoice && eventMember && !eventMember.user?.bot && !isAllowedGroupVoiceMember(enteredGroupVoice, eventMember, enteredChannel)) {
      await newState.disconnect?.(`Unauthorized entry to group voice ${enteredGroupVoice.id}`).catch(error => {
        console.warn('[groups] unauthorized voice disconnect failed:', guildId, memberId, error?.message || error);
      });
      await gm.audit(guildId, memberId, enteredGroupVoice.id, 'group_voice_unauthorized_entry', { channelId: newState.channelId }).catch(() => {});
      return;
    }
    const eligible = group => group && (group.memberIds.includes(memberId) || String(group.owner_id) === memberId || group.managerIds.includes(memberId));
    const tracksChannel = channelId => Boolean(channelId && (
      (settings?.countAllChannels && groups.some(eligible))
      || groups.some(group => group.voice_channel_id === channelId && eligible(group))
    ));
    const oldTracked = tracksChannel(oldState.channelId);
    const newTracked = tracksChannel(newState.channelId);
    const key = `${guildId}:${memberId}`;
    if (newState.channelId && !newTracked && oldState.channelId !== newState.channelId) {
      const isMember = groups.some(eligible);
      await logActivitySkip(guildId, memberId, null, 'voice_ms', isMember ? 'channel_out_of_scope' : 'member_not_eligible', { channelId: newState.channelId }).catch(() => {});
    }
    // With all-channel scope, moving between voice rooms remains one continuous session.
    // In group-only scope, leaving the group's configured voice room closes the session.
    if (oldTracked && !newTracked) {
      const started = voiceStarts.get(key);
      if (started) await gm.recordActivity(guildId, memberId, 'voice_ms', Math.min(120000, Math.max(0, Date.now() - started)), voiceChannels.get(key) || oldState.channelId).catch(error => console.error('[groups] voice points failed:', error?.message || error));
      voiceStarts.delete(key);
      voiceChannels.delete(key);
      await gm.deleteVoiceSession(guildId, memberId).catch(error => console.error('[groups] voice session cleanup failed:', error?.message || error));
    }
    if (newTracked && !oldTracked) {
      const now = Date.now();
      voiceStarts.set(key, now);
      voiceChannels.set(key, newState.channelId);
      await gm.upsertVoiceSession(guildId, memberId, newState.channelId, now).catch(error => console.error('[groups] voice session save failed:', error?.message || error));
    } else if (newTracked && oldTracked && oldState.channelId !== newState.channelId) {
      voiceChannels.set(key, newState.channelId);
      await gm.upsertVoiceSession(guildId, memberId, newState.channelId, voiceStarts.get(key) || Date.now()).catch(error => console.error('[groups] voice session move update failed:', error?.message || error));
    }
    if (!oldTracked && !newTracked) { voiceStarts.delete(key); voiceChannels.delete(key); }
  });

  const handleManagedResourceDelete = async channel => {
    if (!channel.guild) return;
    const groups = (await gm.listGroups(channel.guild.id, true)).filter(group => group.status !== 'deleted');
    for (const group of groups) {
      if (global.groupResourceDeleteBypass?.has(`${channel.guild.id}:${group.id}`)) continue;
      if (![group.text_channel_id, group.thread_id, group.voice_channel_id].includes(channel.id)) continue;
      await restoreGroupResources(channel.guild, group, `channel_deleted:${channel.id}`).catch(error => console.error('[groups] channel restore failed:', error?.message || error));
    }
    activityCache.delete(String(channel.guild.id));
  };
  client.on('channelDelete', handleManagedResourceDelete);
  // Discord.js emits thread deletion separately from channelDelete for some thread types.
  client.on('threadDelete', async thread => {
    await handleManagedResourceDelete(thread).catch(error => console.error('[groups] thread restore failed:', error?.message || error));
  });

  client.on('roleDelete', async role => {
    if (!role.guild) return;
    const groups = (await gm.listGroups(role.guild.id, true)).filter(group => group.status !== 'deleted');
    for (const group of groups) if (group.role_id === role.id) {
      if (global.groupResourceDeleteBypass?.has(`${role.guild.id}:${group.id}`)) continue;
      await restoreGroupResources(role.guild, group, `role_deleted:${role.id}`).catch(error => console.error('[groups] role restore failed:', error?.message || error));
    }
    activityCache.delete(String(role.guild.id));
  });

  client.on('guildMemberRemove', async member => {
    try {
    voiceStarts.delete(`${member.guild.id}:${member.id}`);
    voiceChannels.delete(`${member.guild.id}:${member.id}`);
    await gm.deleteVoiceSession(member.guild.id, member.id).catch(() => {});
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
          if (leader) await successor.roles.add(leader, 'TRANSFER GROUP OWNERSHIP').catch(() => {});
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
    } catch (error) {
      console.error('[groups] member leave synchronization failed:', error?.message || error);
    }
  });

  client.on('channelDelete', channel => {
    const guildId = String(channel?.guild?.id || '');
    topPanelMessageIds.delete(String(channel?.id || ''));
    if (!guildId || topPanelRefreshChannels.get(guildId) !== String(channel.id)) return;
    const timer = topPanelRefreshTimers.get(guildId);
    if (timer) clearInterval(timer);
    topPanelRefreshTimers.delete(guildId);
    topPanelRefreshChannels.delete(guildId);
  });

  client.on('guildDelete', guild => {
    const guildId = String(guild?.id || '');
    const timer = topPanelRefreshTimers.get(guildId);
    if (timer) clearInterval(timer);
    topPanelRefreshTimers.delete(guildId);
    topPanelRefreshChannels.delete(guildId);
    for (const key of [...topPanelMessageIds.keys()]) if (key === guildId || key.startsWith(`${guildId}:`)) topPanelMessageIds.delete(key);
  });

  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    if (oldMember.roles.cache.equals(newMember.roles.cache)) return;
    const syncKey = `${newMember.guild.id}:${newMember.id}`;
    if (groupRoleSyncLocks.has(syncKey)) return;
    groupRoleSyncLocks.add(syncKey);
    try {
    const groups = await gm.listGroups(newMember.guild.id);
    for (const group of groups) {
      if (!group.role_id) continue;
      const had = oldMember.roles.cache.has(group.role_id);
      const has = newMember.roles.cache.has(group.role_id);
      const bypass = global.groupRoleGrantBypass?.has(`${newMember.guild.id}:${newMember.id}:${group.role_id}`);
      const leaveBypass = global.groupLeaveRoleBypass?.has(`${newMember.guild.id}:${newMember.id}:${group.role_id}`);
      const isLinked = group.memberIds.includes(String(newMember.id)) || String(group.owner_id) === String(newMember.id) || group.managerIds.includes(String(newMember.id));
      if (has && !had && !isLinked && !bypass) {
        const pendingKey = `${newMember.guild.id}:${newMember.id}:${group.id}`;
        if (!pendingRoleGuardChecks.has(pendingKey)) {
          const timer = setTimeout(async () => {
            pendingRoleGuardChecks.delete(pendingKey);
            const latest = await gm.getGroup(newMember.guild.id, group.id).catch(() => null);
            const stillLinked = latest && (latest.memberIds.includes(String(newMember.id)) || String(latest.owner_id) === String(newMember.id) || latest.managerIds.includes(String(newMember.id)));
            if (stillLinked) return;
            await newMember.roles.remove(group.role_id, 'Unapproved group role assignment').catch(() => {});
            await gm.audit(newMember.guild.id, null, group.id, 'role_guard_removed', { userId: newMember.id, roleId: group.role_id, delayedVerification: true });
            await gm.logGroupEvent(newMember.guild, 'update', { groupId: group.id, reason: 'role_guard_removed', userId: newMember.id, roleId: group.role_id }, null);
          }, 15000);
          timer.unref?.();
          pendingRoleGuardChecks.set(pendingKey, timer);
        }
      }
      if (!has && had && leaveBypass) continue;
      if (!has && had && isLinked) {
        try {
          await newMember.roles.add(group.role_id, 'Restore managed group membership');
          await gm.audit(newMember.guild.id, null, group.id, 'member_role_restored', { userId: newMember.id, roleId: group.role_id });
          await gm.logGroupEvent(newMember.guild, 'update', { groupId: group.id, reason: 'member_role_restored', userId: newMember.id, roleId: group.role_id }, null);
          await newMember.send(`Group protection\nتمت إعادة رتبة القروب تلقائيًا لأنك عضو مسجل في القروب **${safe(group.name)}**.\nThe group role was restored automatically because you are a registered group member.`).catch(() => {});
        } catch (error) {
          await gm.audit(newMember.guild.id, null, group.id, 'member_role_restore_failed', { userId: newMember.id, roleId: group.role_id, message: String(error?.message || error).slice(0, 200) }).catch(() => null);
          console.error('[groups] failed to restore group member role:', error?.message || error);
        }
        continue;
      }
    }
    activityCache.delete(String(newMember.guild.id));
    } catch (error) {
      console.error('[groups] member role synchronization failed:', error?.message || error);
    } finally {
      groupRoleSyncLocks.delete(syncKey);
    }
  });
}
async function dispatchInternalMessage(message, options = {}) {
  const prefix = Object.prototype.hasOwnProperty.call(options, 'prefix') ? options.prefix : ':';
  const content = String(message?.content || '').trim();
  const hasPrefix = typeof prefix === 'string' && prefix.length > 0 && content.startsWith(prefix);
  const raw = (hasPrefix ? content.slice(prefix.length) : content).trim();
  if (!message?.guild || message.author?.bot) return false;

  const words = raw.split(/\s+/).filter(Boolean);
  const command = String(words[0] || '').toLowerCase();
  const args = words.slice(1);
  const client = message.client;

  // Global group setup entry points work without the normal message prefix.
  // Only reserved aliases are intercepted; ordinary conversation stays untouched.
  if (!hasPrefix && ['setup', 'group-setup', 'إعدادات', 'اعدادات', 'تهيئة'].includes(command)) {
    const setupCommand = client?.commands?.get('setup') || require('./setup');
    await setupCommand.execute(message, args, { client, prefix });
    return true;
  }
  if (!hasPrefix && ['groups', 'group', 'قروب', 'قروبات'].includes(command)) {
    await execute(message, args.length ? args : ['setup'], { client, prefix });
    return true;
  }

  if (command === 'صلاحية' || command === 'permission') {
    try {
      const linked = await gm.getGroupForChannel(message.guild.id, message.channel.id);
      if (!linked) return true;
      const { group } = await currentManager(message, linked.id, true);
      const flow = newFlow(message.guild.id, message.author.id, 'permission', group.id);
      await replyMessage(message, { ...scopePayload(message.guild, flow), allowedMentions: { parse: [] } });
    } catch (error) {
      await replyMessage(message, { content: groupError(error), allowedMentions: { parse: [] } }).catch(() => null);
    }
    return true;
  }

  const consumed = await handleInternalMessage(message, { ...options, sendPanel: sendGroupAdminPanel });
  if (consumed) return true;

  // Outside a linked group channel, the existing system permission check still applies.
  if (!hasPrefix && ['تحكم', 'control'].includes(command)) {
    await execute(message, ['control'], { client, prefix });
    return true;
  }
  return false;
}

// Group-scoped controls. Never edit guild roles, categories, or a shared thread parent.
const { OverwriteType } = require('discord.js');
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
    INVALID_SELECTION: 'اختيار غير صالح؛ افتح القائمة مجدداً.', MEMBER_NOT_FOUND: 'العضو غير موجود في السيرفر أو تعذر جلب بياناته من Discord.', OWNER_NOT_IN_ROLE: 'العضو موجود، لكنه لا يحمل الرول الذي اخترته كـرول للقروب.', BOT_OWNER_NOT_ALLOWED: 'لا يمكن تعيين بوت كمالك للقروب.', NO_VOICE_MEMBERS: 'لا يوجد أعضاء حاليًا داخل قناة القروب الصوتي لفصلهم.',
    TARGET_PROTECTED: 'لا يمكن تقييد مالك القروب أو مسؤوليه أو مديري النظام أو البوت.', TARGET_NOT_IN_GROUP: 'الميوت والنميوت متاحان لأعضاء القروب فقط.',
    CHANNEL_NOT_FOUND: 'قناة القروب المحددة غير موجودة أو نوعها غير صالح.', GROUP_OPERATION_BUSY: 'توجد عملية أخرى تعمل على هذا القروب أو الرول؛ حاول بعد قليل.', MISSING_MANAGE_ROLES: 'البوت لا يملك Manage Roles.', MISSING_MANAGE_CHANNELS: 'البوت لا يملك Manage Channels.', GROUP_ROLE_NOT_EDITABLE: 'رتبة القروب أعلى من رتبة البوت أو غير قابلة للتعديل.', ROLE_ICON_UPDATE_FAILED: 'رفض Discord تحديث أيقونة الرتبة؛ تحقق من أن الرتبة غير مُدارة وأنها قابلة للتعديل.', ROLE_COLOR_UPDATE_FAILED: 'رفض Discord تحديث لون الرتبة؛ تحقق من أن الرتبة غير مُدارة وقابلة للتعديل.',
    SHARED_CHANNEL: 'القناة/أب الثريد مشترك؛ لا يمكن تغيير صلاحياته دون التأثير على قروب أو ثريد آخر.',
    ASSET_LINKED: 'أحد عناصر القروب المختارة مرتبط بقروب آخر؛ لم يتم الاستيراد.', OWNER_ALREADY_HAS_GROUP: 'لا يمكن للعضو امتلاك أكثر من قروب واحد؛ يمكنه دخول قروبات أخرى كعضو.',
    INVALID_ROLE: 'اختر رتبة قروب عادية قابلة للإدارة، غير everyone أو رتبة نظام أو رتبة ذات صلاحيات إدارية.',
    INVALID_THREAD: 'الثريد غير موجود أو لا ينتمي إلى القناة المختارة.',
    OWNER_NOT_IN_THREAD: 'مالك القروب غير عضو في الثريد الخاص؛ أضفه إليه قبل الاستيراد.',
    THREAD_MEMBERS_MISMATCH: 'كل حاملي رتبة القروب يجب أن يكونوا أعضاء في الثريد الخاص قبل ربطه.',
    NAME_REQUIRED: 'الاسم مطلوب (حتى 80 حرفاً).', NAME_EXISTS: 'يوجد قروب آخر بهذا الاسم.',
    INVALID_LIMIT: 'الحد الصوتي عدد صحيح من 0 إلى 99 (0 = بلا حد).',
    NOT_IN_GROUP_VOICE: 'العضو ليس في قناة هذا القروب؛ لن يتم فصله من أي قناة أخرى.',
    MISSING_PERMISSIONS: 'البوت لا يملك الصلاحيات المطلوبة في قناة القروب.',
    GROUP_FULL: 'عدد الأعضاء يتجاوز الحد المحدد للقروبات.', ACTION_BUSY: 'يوجد إجراء جارٍ لهذا القروب، حاول مجدداً.', OWNER_ROLE_NOT_FOUND: 'رتبة مالك القروب غير موجودة؛ لم يتم نقل الملكية.', MANAGER_ROLE_NOT_FOUND: 'رتبة مسؤول القروب غير موجودة؛ لم يتم نقل الملكية.',
    GROUP_TEXT_PERMISSIONS_FAILED: 'تعذر ضبط صلاحيات الشات النصي؛ تأكد أن البوت يملك Manage Channels وأن القناة أو الكاتاقوري ليست محمية باستثناء يمنع التعديل.',
    GROUP_VOICE_PERMISSIONS_FAILED: 'تعذر ضبط صلاحيات قناة الفويس؛ تأكد أن البوت يملك Manage Channels وأن قناة الفويس قابلة للتعديل.',
    SHARED_GROUP_CHAT_UNAVAILABLE: 'تعذر العثور على روم groups-chat المشترك أو إنشاء الثريد داخله؛ تحقق من Manage Channels وCreate Private Threads.',
    SHARED_GROUP_CHAT_ACCESS_FAILED: 'تعذر تعديل صلاحيات روم groups-chat المشترك؛ تحقق من Manage Channels على مستوى السيرفر ومن عدم وجود قفل صلاحيات على الروم.',
    THREAD_CHAT_MODE_REQUIRED: 'نمط الشات الحالي لا يسمح بإنشاء ثريدات؛ عدّل نمط القروبات أو اختر شاتًا نصيًا مستقلًا.',
    THREAD_ARCHIVED: 'الثريد مؤرشف؛ افتحه من Discord قبل منح عضو الوصول إليه.'
  };
  if (String(error?.message).includes('UNIQUE constraint failed')) return messages.NAME_EXISTS;
  if (Number(error?.code) === 50013 || /missing permissions|missing access/i.test(String(error?.message || ''))) {
    return 'رفض Discord العملية بسبب صلاحية على القناة أو الرتبة. تأكد من Manage Channels وManage Threads، وأن رتبة البوت أعلى من رول القروب.';
  }
  if (Number(error?.code) === 10004 || Number(error?.code) === 10003) return 'المورد المطلوب لم يعد موجودًا في Discord؛ أعد فتح لوحة Add وحاول من جديد.';
  return messages[error?.message] || 'تعذر تنفيذ الإجراء. تحقق من صلاحيات البوت وترتيب رتبته؛ لم نمنح أي صلاحية على مستوى السيرفر.';
}
async function currentManager(context, groupId, extra = false) {
  const settings = await gm.getSettings(context.guild.id);
  const member = await context.guild.members.fetch(String(context.user?.id || context.author?.id)).catch(() => null);
  const group = await gm.getGroup(context.guild.id, Number(groupId));
  if (!group || group.status !== 'active') throw new Error('GROUP_NOT_FOUND');
  if (!gm.canManageGroup(context.client, settings, group, member)) throw new Error('NO_PERMISSION');
  // System managers may manage all groups. Ordinary group owners/managers must
  // also still hold the live group role; database membership alone is stale.
  if (!gm.canManageSystem(context.client, settings, member)) {
    const groupRole = group.role_id && (context.guild.roles.cache.get(String(group.role_id)) || await context.guild.roles.fetch(String(group.role_id)).catch(() => null));
    if (!groupRole || !member.roles?.cache?.has(groupRole.id)) throw new Error('NO_PERMISSION');
  }
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
async function reconcileFetch(collection, id) {
  if (!id) return { value: null, error: null };
  const cached = collection.cache.get(String(id));
  if (cached) return { value: cached, error: null };
  try { return { value: await collection.fetch(String(id)), error: null }; }
  catch (error) { return { value: null, error }; }
}
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
  const sharedThreadParent = channel.type === ChannelType.GuildText
    && others.some(g => String(g.text_channel_id || '') === String(channel.id));
  if (others.some(g => gm.channelBelongs(g, channel.id)) && !sharedThreadParent) throw new Error('SHARED_CHANNEL');
  // Threads inherit overwrites from their parent. Only a dedicated, linked parent is safe.
  if (channel.type === ChannelType.GuildText && channel.threads) {
    const threads = await threadChoices(channel);
    const selectedThreadId = String(group.thread_id || '');
    if (selectedThreadId && !threads.some(thread => String(thread.id) === selectedThreadId)) throw new Error('INVALID_THREAD');
    if (!sharedThreadParent && threads.some(thread => String(thread.id) !== selectedThreadId)) throw new Error('SHARED_CHANNEL');
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
    const actionLabel = { lock: 'قفل', unlock: 'فتح', hide: 'إخفاء', show: 'إظهار', mute: 'كتم', unmute: 'فك الكتم' }[action] || action;
    const scopeLabel = scope === 'voice' ? 'قناة الفويس' : 'القناة';
    return `تم ${actionLabel} ${scopeLabel} الخاص بالقروب فقط.`;
  });
}
function controlGroupPayload(guild, groupId) {
  const c = baseContainer(guild, 'GROUP CONTROL');
  const id = Number(groupId);
  const emoji = {
    open: '<:emoji_15:1485476015688908830>',
    unlock: '<:emoji_15:1485476015688908830>',
    lock: '<:emoji_18:1485476234199826472>',
    show: '<:emoji_17:1485476188091580446>',
    hide: '<:emoji_17:1485476100774821938>',
    mute: '<:emoji_28:1485476660055638146>',
    unmute: '<:emoji_30:1485476749889503334>',
    rename: '<:emoji_5:1484364982094266428>',
    limit: '<:emoji_19:1485476294966640781>',
    allow: '<:emoji_21:1485476368740519986>',
    deny: '<:emoji_23:1485476405151268904>',
    kick: '<:emoji_33:1485476862619680788>',
    permission: '<:emoji_21:1485476329171320855>'
  };
  const addControlSection = (title, controls) => {
    c.addSeparatorComponents(new SeparatorBuilder());
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${title}`));
    for (let offset = 0; offset < controls.length; offset += 3) {
      c.addActionRowComponents(new ActionRowBuilder().addComponents(
        controls.slice(offset, offset + 3).map(([action, scope, label]) =>
          button(`groups_control:${action}:${id}:${scope}`, label, ButtonStyle.Secondary, emoji[action])
        )
      ));
    }
  };
  addControlSection('ROOM CONTROL', [
    ['lock', 'text', 'Lock Room'], ['unlock', 'text', 'Open Room'], ['hide', 'text', 'Hide Room'],
    ['show', 'text', 'Show Room'], ['mute', 'text', 'Mute'], ['unmute', 'text', 'Unmute']
  ]);
  addControlSection('VOICE CONTROL', [
    ['lock', 'voice', 'Lock Voice'], ['unlock', 'voice', 'Open Voice'], ['hide', 'voice', 'Hide Voice'],
    ['show', 'voice', 'Show Voice'], ['mute', 'voice', 'Mute'], ['unmute', 'voice', 'Unmute'],
    ['kick', 'voice', 'Kick'], ['limit', 'voice', 'Limit']
  ]);
  addControlSection('MEMBERS & ACCESS', [
    ['allow', 'both', 'Allow'], ['deny', 'both', 'Deny'], ['rename', 'both', 'Rename'], ['permission', 'both', 'Permissions']
  ]);
  c.addSeparatorComponents(new SeparatorBuilder());
  c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('GROUP INFORMATION')).setButtonAccessory(button(`groups_member:info:${id}`, 'MY GROUP', ButtonStyle.Secondary, emoji.permission)));
  return componentsV2Payload(c);
}
function groupMetadataPayload(guild, groupId) {
  const id = Number(groupId);
  const c = baseContainer(guild, 'GROUP SETTINGS', 'تعديل بيانات القروب الأساسية فقط.');
  c.addSeparatorComponents(new SeparatorBuilder());
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent('### GROUP DETAILS'));
  c.addActionRowComponents(new ActionRowBuilder().addComponents(
    button(`groups_meta_edit:name:${id}`, 'NAME', ButtonStyle.Secondary, '<:emoji_5:1484364982094266428>'),
    button(`groups_meta_edit:description:${id}`, 'DESCRIPTION', ButtonStyle.Secondary, '<:emoji_35:1465383704993202452>'),
    button(`groups_meta_edit:emoji:${id}`, 'EMOJI', ButtonStyle.Secondary, '<:emoji_33:1465383582292771025>'),
    button(`groups_meta_edit:color:${id}`, 'COLOR', ButtonStyle.Secondary, '<:emoji_35:1465383704993202452>'),
    button(`groups_meta_edit:avatar:${id}`, 'AVATAR', ButtonStyle.Secondary, '<:emoji_3:1465210427494502400>')
  ));
  return componentsV2Payload(c);
}
function flowSelect(guild, flow, title, description, options, noValue = null) {
  const payload = selectPayload(guild, title, description, flowId(flow), options);
  if (noValue) payload.components[0].addActionRowComponents(new ActionRowBuilder().addComponents(button(`groups_flow:${flow.token}:${noValue}`, 'لا يوجد — إنشاء تلقائي', ButtonStyle.Secondary)));
  return payload;
}
function entitySelect(guild, flow, title, description, menu, noValue = null) {
  const c = baseContainer(guild, title, description);
  c.addActionRowComponents(new ActionRowBuilder().addComponents(menu.setCustomId(flowId(flow)).setMinValues(1).setMaxValues(1)));
  if (noValue) c.addActionRowComponents(new ActionRowBuilder().addComponents(button(`groups_flow:${flow.token}:${noValue}`, 'لا يوجد — إنشاء تلقائي', ButtonStyle.Secondary)));
  c.addActionRowComponents(new ActionRowBuilder().addComponents(button(`groups_flow:${flow.token}:cancel`, 'CANCEL')));
  return componentsV2Payload(c);
}
async function voiceMemberSelect(interaction, flow) {
  const group = await gm.getGroup(interaction.guild.id, flow.groupId);
  const ids = [...new Set([group?.owner_id, ...(group?.memberIds || []), ...(group?.managerIds || [])].filter(Boolean).map(String))];
  const members = (await Promise.all(ids.map(id => interaction.guild.members.fetch(id).catch(() => null))))
    .filter(member => member?.voice?.channelId === String(group?.voice_channel_id));
  if (!members.length) throw new Error('NO_VOICE_MEMBERS');
  const visibleMembers = members.slice(0, 25);
  flow.memberFilterIds = visibleMembers.map(member => String(member.id));
  const menu = new StringSelectMenuBuilder()
    .setPlaceholder('اختر عضوًا موجودًا في الفويس')
    .addOptions(visibleMembers.map(member => ({
      label: safe(member.displayName || member.user?.username || member.id, 100),
      value: String(member.id),
      description: 'في قناة القروب الصوتي'
    })));
  return entitySelect(interaction.guild, flow, 'KICK VOICE MEMBER', 'اختر عضوًا من الموجودين حاليًا في قناة القروب الصوتي لفصله من القناة فقط.', menu);
}
function scopePayload(guild, flow) {
  return flowSelect(guild, flow, 'SELECT ROOM SCOPE', 'اختر نطاق الرومات.', [{ label: 'Text Room / Thread', value: 'text', description: 'القناة النصية.' }, { label: 'Voice Room', value: 'voice', description: 'القناة الصوتية.' }, { label: 'Text + Voice', value: 'both', description: 'القناتان معًا.' }]);
}
function confirmFlowPayload(guild, flow, description) {
  const c = baseContainer(guild, 'CONFIRM GROUP ACTION', description);
  c.addActionRowComponents(new ActionRowBuilder().addComponents(button(flowId(flow), 'CONFIRM', ButtonStyle.Success), button(`groups_flow:${flow.token}:cancel`, 'CANCEL')));
  return componentsV2Payload(c);
}
function importGroupName(role) {
  return safe(String(role?.name || '').replace(/^Group[・\s]+/i, ''), 80).trim() || 'Group';
}
async function findSharedGroupChat(guild, settings) {
  return (await gm.getOrCreateSharedGroupChat(guild, settings, { createIfMissing: false })).text;
}
async function createImportTextResources(guild, flow, settings, role) {
  const name = importGroupName(role);
  const created = [];
  try {
    if (flow.createText && settings.chatMode !== 'threads') throw new Error('THREAD_CHAT_MODE_REQUIRED');
    let text = settings.chatMode === 'threads' ? await findSharedGroupChat(guild, settings) : null;
    let createdText = false;
    if (!text && settings.chatMode === 'threads') throw new Error('SHARED_GROUP_CHAT_UNAVAILABLE');
    if (!text) {
      text = await guild.channels.create({
        name: `📝・${name}`.slice(0, 100),
        type: ChannelType.GuildText,
        parent: settings.textCategoryId || undefined,
        permissionOverwrites: groupChannelOverwrites(guild, role.id),
        reason: 'Create group resources from admin Add'
      });
      createdText = true;
      created.push(text);
    } else if (settings.chatMode === 'threads') {
      await text.permissionOverwrites.edit(role.id, Object.fromEntries(GROUP_TEXT_ACCESS.map(flag => [flag, true])), { reason: 'Add imported group role to shared group chat' });
    }
    flow.textId = text.id;
    flow.threadId = null;
    if (settings.chatMode === 'threads') {
      const thread = await text.threads.create({ name, type: ChannelType.PrivateThread, invitable: false, reason: 'Create group thread from admin Add' });
      created.push(thread);
      flow.threadId = thread.id;
    }
    return { text, thread: flow.threadId ? await channelById(guild, flow.threadId) : null, createdText };
  } catch (error) {
    for (const resource of created.reverse()) await resource.delete('Rollback failed group resource import').catch(() => {});
    throw error;
  }
}
async function createImportVoiceResource(guild, flow, settings, role) {
  const name = importGroupName(role);
  const voice = await guild.channels.create({
    name,
    type: ChannelType.GuildVoice,
    parent: settings.voiceCategoryId || undefined,
    permissionOverwrites: groupVoiceOverwrites(guild, role.id),
    reason: 'Create group voice resource from admin Add'
  });
  flow.voiceId = voice.id;
  return voice;
}
async function showRenameModal(interaction, groupId, scope) {
  choose(scope, ['name', 'text', 'voice']);
  const { group } = await currentManager(interaction, groupId);
  const flow = newFlow(interaction.guild.id, interaction.user.id, 'rename', group.id);
  flow.scope = scope; flow.step = 'submit';
  const modal = new ModalBuilder().setCustomId(flowId(flow)).setTitle('RENAME GROUP ROOM');
  modal.addLabelComponents(new LabelBuilder().setLabel('New name').setTextInputComponent(new TextInputBuilder().setCustomId('value').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80).setValue(safe(group.name, 80)).setPlaceholder('أدخل الاسم الجديد')));
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
  const role = scope === 'name' && group.role_id ? (context.guild.roles.cache.get(String(group.role_id)) || await context.guild.roles.fetch(String(group.role_id)).catch(() => null)) : null;
  if (scope === 'name' && !role) throw new Error('GROUP_ROLE_NOT_FOUND');
  if (role && !role.editable) throw new Error('GROUP_ROLE_NOT_EDITABLE');
  const changed = [];
  let roleChanged = false;
  try {
    for (const channel of channels) {
      const oldName = channel.name;
      await channel.setName(value, `Group rename by ${context.user?.id || context.author.id}`);
      changed.push({ channel, oldName });
    }
    if (scope === 'name') {
      await role.setName(value, `Group role rename by ${context.user?.id || context.author.id}`);
      roleChanged = true;
      await gm.updateGroup(context.guild.id, group.id, { name: value, updated_at: Date.now() }, context.user?.id || context.author.id);
    }
    await gm.audit(context.guild.id, context.user?.id || context.author.id, group.id, 'control_rename', { scope, name: value });
  } catch (error) {
    if (roleChanged) await role.setName(group.name, 'Rollback group role rename').catch(() => { error.groupRollbackFailed = true; });
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
      await notifyGroupDM(interaction.guild, target.id, 'GROUP VOICE UPDATE', `تم فصلك من قناة الصوت الخاصة بقروب **${safe(group.name,100)}** بواسطة مسؤول القروب.`);
      return 'تم فصل العضو من قناة القروب فقط (ليس طرداً من السيرفر).';
    }
    if (flow.action === 'mute' || flow.action === 'unmute') {
      if (!isGroupMember(group, target.id)) throw new Error('TARGET_NOT_IN_GROUP');
      const channels = await groupChannels(interaction.guild, group, flow.scope);
      const enabled = flow.action === 'unmute';
      const edits = channels.map(channel => ({
        channel,
        id: target.id,
        patch: Object.fromEntries((channel.type === ChannelType.GuildVoice
          ? ['Speak', 'Stream', 'UseVAD']
          : ['SendMessages', 'SendMessagesInThreads', 'AddReactions']).map(flag => [flag, enabled]))
      }));
      await applyChannelEdits(edits, `Group ${flow.action} member by ${interaction.user.id}`);
      await gm.audit(interaction.guild.id, interaction.user.id, group.id, `control_${flow.action}`, { scope: flow.scope, userId: target.id });
      await notifyGroupDM(interaction.guild, target.id, enabled ? 'GROUP MUTE REMOVED' : 'GROUP MEMBER MUTED', `تم ${enabled ? 'فك الميوت عنك' : 'تطبيق الميوت عليك'} في ${flow.scope === 'voice' ? 'قناة الصوت' : flow.scope === 'text' ? 'القناة النصية' : 'القناتين'} الخاصة بقروب **${safe(group.name,100)}**.`);
      return `تم ${enabled ? 'فك الميوت' : 'تطبيق الميوت'} على <@${target.id}> في ${flow.scope === 'voice' ? 'قناة الفويس' : flow.scope === 'text' ? 'القناة النصية' : 'القناتين النصية والصوتية'} فقط.`;
    }
    choose(flow.action, ['allow', 'deny']);
    if (flow.action === 'deny' && (String(group.owner_id) === String(target.id) || group.managerIds.includes(String(target.id)))) {
      throw new Error('TARGET_PROTECTED');
    }
    const channels = await groupChannels(interaction.guild, group, flow.scope);
    const allowed = flow.action === 'allow';
    const thread = flow.scope !== 'voice' && group.thread_id ? await channelById(interaction.guild, group.thread_id) : null;
    if (thread?.archived && allowed) throw new Error('THREAD_ARCHIVED');
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
    await notifyGroupDM(interaction.guild, target.id, flow.action === 'allow' ? 'GROUP ACCESS GRANTED' : 'GROUP ACCESS REMOVED', flow.action === 'allow' ? `تم السماح لك بالوصول إلى موارد قروب **${safe(group.name,100)}**.` : `تم إيقاف وصولك إلى موارد قروب **${safe(group.name,100)}** بواسطة مسؤول القروب.`);
    const actionLabel = flow.action === 'allow' ? 'السماح' : 'المنع';
    const scopeLabel = flow.scope === 'voice' ? 'قناة الفويس' : flow.scope === 'text' ? 'القناة' : 'القناتين النصية والصوتية';
    return `تم ${actionLabel} للعضو في ${scopeLabel} فقط؛ لم تتغير صلاحيات رتب السيرفر.`;
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
    const modeLabel = { allow: 'السماح', deny: 'المنع', inherit: 'إزالة الاستثناء' }[flow.mode] || flow.mode;
    return `تم ${modeLabel} لصلاحية ${flow.permission} على رومات القروب فقط.`;
  });
}
function permissionOptions(flow) {
  const labels = { ViewChannel: 'View Room', SendMessages: 'Send Messages', SendMessagesInThreads: 'Send in Threads', ReadMessageHistory: 'Read History', AddReactions: 'Add Reactions', AttachFiles: 'Attach Files', EmbedLinks: 'Embed Links', Connect: 'Connect', Speak: 'Speak', Stream: 'Stream', UseVAD: 'Use Voice Activity' };
  return SAFE_PERMISSIONS[flow.scope].map(flag => ({ label: labels[flag] || flag, value: flag, description: `صلاحية ${labels[flag] || flag} داخل رومات القروب.` }));
}
async function validateImport(guild, flow, settings, includeMembers = false) {
  const groups = (await gm.listGroups(guild.id, true)).filter(g => g.status !== 'deleted');
  // In thread mode the parent text channel is deliberately shared by all
  // groups. Only the selected thread and voice channel must be exclusive;
  // treating the shared parent as an occupied asset rejects valid owners.
  const linkedIds = [flow.textId, flow.threadId, flow.voiceId]
    .filter(id => id && !(settings.chatMode === 'threads' && String(id) === String(flow.textId)));
  if (groups.some(g => (flow.roleId && String(g.role_id || '') === String(flow.roleId)) || linkedIds.some(id => gm.channelBelongs(g, id)))) throw new Error('ASSET_LINKED');
  const role = flow.roleId ? await guild.roles.fetch(flow.roleId).catch(() => null) : null;
  if (flow.roleId && (!role || role.id === guild.id || role.managed || !role.editable || [settings.leaderRoleId, settings.managerRoleId, ...settings.systemRoles].includes(role.id) || role.permissions.has([PermissionsBitField.Flags.Administrator], false) || role.permissions.any([PermissionsBitField.Flags.ManageRoles, PermissionsBitField.Flags.ManageGuild, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ModerateMembers, PermissionsBitField.Flags.KickMembers, PermissionsBitField.Flags.BanMembers]))) throw new Error('INVALID_ROLE');
  const owner = flow.ownerId
    ? await guild.members.fetch({ user: String(flow.ownerId), force: true }).catch(() => guild.members.fetch(String(flow.ownerId)).catch(() => null))
    : null;
  if (flow.ownerId && !owner) throw new Error('MEMBER_NOT_FOUND');
  if (owner?.user?.bot) throw new Error('BOT_OWNER_NOT_ALLOWED');
  if (flow.ownerId && !owner.roles.cache.has(flow.roleId)) throw new Error('OWNER_NOT_IN_ROLE');
  if (owner && groups.some(g => String(g.owner_id) === String(owner.id))) throw new Error('OWNER_ALREADY_HAS_GROUP');
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
    members = [...role.members.values()].map(member => String(member.id));
    if (!members.includes(owner.id)) throw new Error('OWNER_NOT_IN_ROLE');
    // When the flow started with “no text room”, the text resource is created
    // only after the voice-selection step. Do not dereference it during this
    // intermediate validation; saveImportedGroup performs the full validation
    // again after all missing resources have been created.
    if (text && voice) {
      await groupChannels(guild, { id: null, text_channel_id: text.id, thread_id: thread?.id || null, voice_channel_id: voice.id }, 'both');
    }
  }
  return { role, owner, text, thread, voice, members };
}
async function addImportThreadMembers(thread, members) {
  if (!thread || !members.length) return [];
  const failed = [];
  await runWithConcurrency(members, 4, async userId => {
    if (!(await restoreThreadMember(thread, userId))) failed.push(String(userId));
  });
  return failed;
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
    const created = [];
    const permissionSnapshots = [];
    let operationToken = null;
    // Import changes membership and shared resources, so the durable lock must
    // cover the whole guild rather than only the selected role.
    const operationKey = `guild:${interaction.guild.id}:group-import`;
    try {
      // Acquire the durable lock before any Discord resource is created or changed.
      // This closes the race where two confirmations both pass the initial validation.
      operationToken = await gm.acquireOperationLock(operationKey, 180000);
      if (!operationToken) throw new Error('GROUP_OPERATION_BUSY');
      let { role, owner } = await validateImport(interaction.guild, flow, settings, false);
      if (!role || !owner) throw new Error('MEMBER_NOT_FOUND');
      if (!flow.textId) {
        const resources = await createImportTextResources(interaction.guild, flow, settings, role);
        if (resources.createdText) created.push(resources.text);
        if (resources.thread) created.push(resources.thread);
      } else if (flow.createThread && !flow.threadId) {
        const text = await channelById(interaction.guild, flow.textId);
        if (!text || text.type !== ChannelType.GuildText) throw new Error('CHANNEL_NOT_FOUND');
        if ((await threadChoices(text)).length) throw new Error('SHARED_CHANNEL');
        const thread = await text.threads.create({ name: importGroupName(role), type: ChannelType.PrivateThread, invitable: false, reason: 'Create group thread from admin Add' });
        flow.threadId = thread.id;
        created.push(thread);
      }
      if (!flow.voiceId) {
        const voice = await createImportVoiceResource(interaction.guild, flow, settings, role);
        created.push(voice);
      }
      const assets = await validateImport(interaction.guild, flow, settings, true);
      const { text, thread, voice, members } = assets;
      const groupName = importGroupName(role);
      if (!groupName) throw new Error('NAME_REQUIRED');
      const existingNames = await gm.listGroups(interaction.guild.id, true);
      if (existingNames.some(item => item.status === 'active' && String(item.name).toLowerCase() === groupName.toLowerCase())) throw new Error('NAME_EXISTS');
      const textFlags = GROUP_TEXT_ACCESS;
      const voiceFlags = GROUP_VOICE_ACCESS;
      for (const [channel, flags] of [[text, textFlags], [voice, voiceFlags]]) {
        const previous = channel.permissionOverwrites.cache.get(role.id);
        permissionSnapshots.push({ channel, roleId: role.id, existed: Boolean(previous), values: Object.fromEntries(flags.map(flag => [flag, previous?.allow.has(PermissionsBitField.Flags[flag]) ? true : previous?.deny.has(PermissionsBitField.Flags[flag]) ? false : null])) });
      }
      const everyoneVoiceId = interaction.guild.roles.everyone.id;
      const previousEveryoneVoice = voice.permissionOverwrites.cache.get(everyoneVoiceId);
      permissionSnapshots.push({ channel: voice, roleId: everyoneVoiceId, existed: Boolean(previousEveryoneVoice), values: { ViewChannel: previousEveryoneVoice?.allow.has(PermissionsBitField.Flags.ViewChannel) ? true : previousEveryoneVoice?.deny.has(PermissionsBitField.Flags.ViewChannel) ? false : null, Connect: previousEveryoneVoice?.allow.has(PermissionsBitField.Flags.Connect) ? true : previousEveryoneVoice?.deny.has(PermissionsBitField.Flags.Connect) ? false : null } });
      await text.permissionOverwrites.edit(role.id, Object.fromEntries(textFlags.map(flag => [flag, true])), { reason: 'Apply imported group text permissions' });
      await voice.permissionOverwrites.edit(everyoneVoiceId, { ViewChannel: true, Connect: false }, { reason: 'Make group voice visible but not publicly joinable' });
      await voice.permissionOverwrites.edit(role.id, Object.fromEntries(voiceFlags.map(flag => [flag, true])), { reason: 'Apply imported group voice permissions' });
      await gm.schema();
      const groupId = await dbManager.transaction(async tx => {
        const existing = await tx.all("SELECT * FROM managed_groups WHERE guild_id = ? AND status != 'deleted'", [interaction.guild.id]);
        // groups-chat is a shared parent in thread mode. Persist it on the
        // group, but do not use it as an exclusive asset during collision checks.
        const assetIds = [settings.chatMode === 'threads' ? null : text.id, thread?.id, voice.id].filter(Boolean);
        for (const row of existing) {
          if (row.role_id === role.id || assetIds.some(id => [row.text_channel_id, row.thread_id, row.voice_channel_id].includes(id))) throw new Error('ASSET_LINKED');
          if (row.status === 'active' && row.name === groupName) throw new Error('NAME_EXISTS');
        }
        const now = Date.now();
        const result = await tx.run(`INSERT INTO managed_groups(guild_id,name,description,owner_id,manager_ids_json,member_ids_json,blocked_ids_json,role_id,text_channel_id,thread_id,voice_channel_id,color,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [interaction.guild.id, groupName, '', owner.id, '[]', JSON.stringify(members), '[]', role.id, text.id, thread?.id || null, voice.id, role.hexColor || '#5865F2', now, now]);
        const importedId = result.id ?? result.lastID;
        if (!Number.isSafeInteger(importedId) || importedId <= 0) throw new Error('GROUP_NOT_FOUND');
        await tx.run('INSERT INTO group_audit_log(guild_id,group_id,actor_id,action,details_json,created_at) VALUES(?,?,?,?,?,?)', [interaction.guild.id, importedId, interaction.user.id, 'group_add', JSON.stringify({ roleId: role.id, ownerId: owner.id, textId: text.id, threadId: thread?.id || null, voiceId: voice.id, members: members.length }), now]);
        return importedId;
      }, 'group-add');
      const failedMembers = await addImportThreadMembers(thread, members);
      if (failedMembers.length) await gm.audit(interaction.guild.id, interaction.user.id, groupId, 'group_thread_members_restore_failed', { userIds: failedMembers }).catch(() => {});
      invalidateGroupCaches(interaction.guild.id);
      // نشر دليل الأوامر داخل مورد القروب نفسه فور اكتمال الإنشاء.
      // في نمط الثريد يكون الهدف هو الثريد، وفي نمط الرومات تكون القناة النصية.
      await sendGroupCommandGuide(thread || text, { name: groupName }, settings).catch(error => {
        console.error('[groups] failed to publish imported group command guide:', error?.message || error);
      });
      const importedGroup = await gm.getGroup(interaction.guild.id, groupId).catch(() => null);
      if (importedGroup) await notifyGroupParties(interaction.guild, importedGroup, interaction.user.id, 'GROUP ADDED', `تم ربط القروب الموجود بالنظام بنجاح.\n\n${groupResourceSummary(importedGroup)}\n**Members Added :** ${members.length - failedMembers.length} / ${members.length}`);
      const result = `تم إنشاء وربط القروب **${safe(groupName)}** (#${groupId}) مع الرول وإضافة ${members.length - failedMembers.length} من ${members.length} عضوًا.${failedMembers.length ? ` تعذرت إضافة ${failedMembers.length} عضوًا للثريد وسيتم تسجيلها للمراجعة.` : ''}`;
      await gm.releaseOperationLock(operationKey, operationToken);
      operationToken = null;
      return result;
    } catch (error) {
      for (const snapshot of permissionSnapshots.reverse()) {
        await snapshot.channel.permissionOverwrites.edit(snapshot.roleId, snapshot.values, { reason: 'Rollback failed group Add permissions' }).catch(() => {});
        if (!snapshot.existed) await snapshot.channel.permissionOverwrites.delete(snapshot.roleId, 'Remove rollback group overwrite').catch(() => {});
      }
      for (const resource of created.reverse()) await resource?.delete?.('Rollback failed group Add').catch(() => {});
      await gm.releaseOperationLock(operationKey, operationToken);
      throw error;
    }
  });
}
async function advanceImport(interaction, flow, settings) {
  const value = ['confirm', 'no-text', 'no-thread', 'no-voice'].includes(flow.step) ? null : oneValue(interaction);
  if (flow.step === 'role') {
    flow.roleId = value; await validateImport(interaction.guild, flow, settings);
    flow.step = 'owner';
    return entitySelect(interaction.guild, flow, 'IMPORT GROUP : OWNER', 'اختر عضواً يحمل رتبة القروب المختارة، بشرط ألا يكون مالك قروب آخر.', new UserSelectMenuBuilder().setPlaceholder('مالك القروب الموجود'));
  }
  if (flow.step === 'owner') {
    flow.ownerId = value; await validateImport(interaction.guild, flow, settings);
    flow.step = 'text';
    return entitySelect(interaction.guild, flow, 'IMPORT GROUP : TEXT CHANNEL', 'اختر الروم النصي أو أب الثريد. إذا لم يوجد اضغط «لا يوجد» لإنشائه باسم الرول.', new ChannelSelectMenuBuilder().setChannelTypes(ChannelType.GuildText).setPlaceholder('شات القروب النصي الموجود'), 'no-text');
  }
  if (flow.step === 'text') {
    flow.textId = value; await validateImport(interaction.guild, flow, settings);
    flow.step = 'chat';
    return flowSelect(interaction.guild, flow, 'IMPORT GROUP : CHAT MODE', 'استخدم الروم نفسه أو اختر ثريدًا موجودًا تحته. يمكنك إنشاء الثريد تلقائيًا إذا لم يوجد.', [{ label: 'استخدام الشات النصي بدون ثريد', value: 'channel' }, { label: 'ربط ثريد موجود', value: 'thread' }], 'no-thread');
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
    return entitySelect(interaction.guild, flow, 'IMPORT GROUP : VOICE CHANNEL', 'اختر قناة القروب الصوتي أو اضغط «لا يوجد» لإنشائها باسم الرول.', new ChannelSelectMenuBuilder().setChannelTypes(ChannelType.GuildVoice).setPlaceholder('قناة فويس القروب الموجود'), 'no-voice');
  }
  if (flow.step === 'no-thread') {
    flow.createThread = true;
    flow.threadId = null;
    flow.step = 'voice';
    return entitySelect(interaction.guild, flow, 'IMPORT GROUP : VOICE CHANNEL', 'اختر قناة القروب الصوتي أو اضغط «لا يوجد» لإنشائها باسم الرول.', new ChannelSelectMenuBuilder().setChannelTypes(ChannelType.GuildVoice).setPlaceholder('قناة فويس القروب الموجود'), 'no-voice');
  }
  if (flow.step === 'thread') {
    if (!flow.threads.slice((flow.page || 0) * 25, ((flow.page || 0) + 1) * 25).some(t => t.id === value)) throw new Error('INVALID_SELECTION');
    flow.threadId = value; await validateImport(interaction.guild, flow, settings);
    flow.step = 'voice';
    return entitySelect(interaction.guild, flow, 'IMPORT GROUP : VOICE CHANNEL', 'اختر قناة القروب الصوتي أو اضغط «لا يوجد» لإنشائها باسم الرول.', new ChannelSelectMenuBuilder().setChannelTypes(ChannelType.GuildVoice).setPlaceholder('قناة فويس القروب الموجود'), 'no-voice');
  }
  if (flow.step === 'no-text') {
    if (settings.chatMode !== 'threads') throw new Error('THREAD_CHAT_MODE_REQUIRED');
    flow.createText = true;
    flow.textId = null;
    flow.threadId = null;
    flow.step = 'voice';
    return entitySelect(interaction.guild, flow, 'IMPORT GROUP : VOICE CHANNEL', 'اختر قناة القروب الصوتي أو اضغط «لا يوجد» لإنشائها باسم الرول.', new ChannelSelectMenuBuilder().setChannelTypes(ChannelType.GuildVoice).setPlaceholder('قناة فويس القروب الموجود'), 'no-voice');
  }
  if (flow.step === 'voice') {
    flow.voiceId = value;
    const assets = await validateImport(interaction.guild, flow, settings, true);
    flow.step = 'confirm';
    const textLabel = assets.text ? `<#${assets.text.id}>` : 'سيتم استخدام groups-chat الرئيسي';
    const threadLabel = assets.thread ? `<#${assets.thread.id}>` : 'سيتم إنشاء ثريد تلقائيًا';
    const voiceLabel = assets.voice ? `<#${assets.voice.id}>` : 'سيتم إنشاء قناة فويس تلقائيًا';
    return confirmFlowPayload(interaction.guild, flow, `Role: <@&${assets.role.id}>\nOwner: <@${assets.owner.id}>\nText: ${textLabel}\nThread: ${threadLabel}\nVoice: ${voiceLabel}\nMembers: ${assets.members.length}\nسيتم ربط الرول وإضافة الأعضاء بالتوازي داخل الثريد وتطبيق صلاحيات الرول فقط.`);
  }
  if (flow.step === 'no-voice') {
    flow.createVoice = true;
    flow.voiceId = null;
    flow.step = 'confirm';
    const role = await interaction.guild.roles.fetch(flow.roleId).catch(() => null);
    const owner = await interaction.guild.members.fetch(flow.ownerId).catch(() => null);
    return confirmFlowPayload(interaction.guild, flow, `Role: <@&${role?.id || flow.roleId}>\nOwner: <@${owner?.id || flow.ownerId}>\nسيتم إنشاء الموارد الناقصة، ربط الرول، وإضافة جميع أعضائه للقروب.`);
  }
  if (flow.step === 'confirm') {
    if (!interaction.isButton?.()) throw new Error('INVALID_SELECTION');
    const result = await saveImportedGroup(interaction, flow);
    forgetFlow(flow);
    return componentsV2Payload(baseContainer(interaction.guild, 'GROUP IMPORTED', result));
  }
  throw new Error('INVALID_SELECTION');
}
async function advancePermission(interaction, flow) {
  if (flow.step === 'scope') {
    flow.scope = choose(oneValue(interaction), ['text', 'voice', 'both']); flow.step = 'target';
    return flowSelect(interaction.guild, flow, 'PERMISSION TARGET', 'اختر تطبيق الصلاحية على رول القروب أو عضو واحد فقط.', [{ label: 'Group Role', value: 'role', description: 'تطبيقها على رول القروب.' }, { label: 'Member', value: 'member', description: 'تطبيقها على عضو محدد.' }]);
  }
  if (flow.step === 'target') {
    flow.targetKind = choose(oneValue(interaction), ['role', 'member']);
    if (flow.targetKind === 'member') {
      flow.step = 'member';
      return entitySelect(interaction.guild, flow, 'PERMISSION MEMBER', 'اختر عضوًا موجودًا. لا يمكن تقييد المالك أو المسؤولين.', new UserSelectMenuBuilder().setPlaceholder('اختر عضوًا'));
    }
    flow.step = 'flag';
    return flowSelect(interaction.guild, flow, 'SELECT PERMISSION', 'اختر صلاحية آمنة واحدة فقط داخل قناة القروب.', permissionOptions(flow));
  }
  if (flow.step === 'member') {
    flow.targetId = oneValue(interaction);
    const { settings, group } = await currentManager(interaction, flow.groupId, true);
    await targetMember(interaction, settings, group, flow.targetId);
    flow.step = 'flag';
    return flowSelect(interaction.guild, flow, 'SELECT PERMISSION', 'اختر صلاحية آمنة واحدة فقط داخل قناة القروب.', permissionOptions(flow));
  }
  if (flow.step === 'flag') {
    flow.permission = choose(oneValue(interaction), SAFE_PERMISSIONS[flow.scope]); flow.step = 'mode';
    return flowSelect(interaction.guild, flow, 'SELECT PERMISSION MODE', 'اختر سماحًا أو منعًا أو إزالة الاستثناء والعودة للوضع الافتراضي.', [{ label: 'Allow', value: 'allow', description: 'السماح بهذه الصلاحية.' }, { label: 'Deny', value: 'deny', description: 'منع هذه الصلاحية.' }, { label: 'Inherit', value: 'inherit', description: 'إزالة الاستثناء.' }]);
  }
  if (flow.step === 'mode') {
    flow.mode = choose(oneValue(interaction), ['allow', 'deny', 'inherit']); flow.step = 'confirm';
    return confirmFlowPayload(interaction.guild, flow, `النطاق : ${flow.scope}\nالهدف : ${flow.targetKind === 'role' ? 'رول القروب' : `<@${flow.targetId}>`}\nالصلاحية : ${flow.permission}\nالوضع : ${flow.mode}\nلن تتغير أي صلاحيات خارج رومات القروب.`);
  }
  if (flow.step === 'confirm') {
    if (!interaction.isButton?.()) throw new Error('INVALID_SELECTION');
    const result = await applyPermission(interaction, flow);
    forgetFlow(flow);
    return componentsV2Payload(baseContainer(interaction.guild, 'PERMISSION UPDATED', result));
  }
  throw new Error('INVALID_SELECTION');
}
async function handleGroupExtensions(interaction) {
  const [prefix, action, groupIdRaw, scope] = String(interaction.customId || '').split(':');
  if (!['groups_control', 'groups_flow'].includes(prefix) && !(prefix === 'groups_admin' && ['add', 'import'].includes(action))) return false;
  let flow;
  try {
    if (!interaction.guild) throw new Error('NO_PERMISSION');
    if (prefix === 'groups_admin') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await currentSystem(interaction);
      flow = newFlow(interaction.guild.id, interaction.user.id, 'import'); flow.step = 'role';
      return interaction.editReply(entitySelect(interaction.guild, flow, 'ADD EXISTING GROUP', 'اختر الرول. بعد ذلك يمكنك اختيار الرومات الموجودة أو الضغط على «لا يوجد» لإنشائها تلقائيًا باسم الرول.', new RoleSelectMenuBuilder().setPlaceholder('رول القروب الموجود')));
    }
    if (prefix === 'groups_control') {
      const groupId = Number(groupIdRaw);
      if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new Error('GROUP_NOT_FOUND');
      if (action === 'limit') {
        await currentManager(interaction, groupId);
        flow = newFlow(interaction.guild.id, interaction.user.id, 'limit', groupId); flow.step = 'submit';
        const modal = new ModalBuilder().setCustomId(flowId(flow)).setTitle('SET VOICE LIMIT');
        modal.addLabelComponents(new LabelBuilder().setLabel('Voice limit').setTextInputComponent(new TextInputBuilder().setCustomId('value').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2).setPlaceholder('من 0 إلى 99، اكتب 0 لإزالة الحد')));
        return interaction.showModal(modal);
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await currentManager(interaction, groupId, ['mute', 'unmute', 'kick', 'allow', 'deny', 'permission'].includes(action));
      if (CONTROL_ACTIONS.has(action) && !['mute', 'unmute'].includes(action)) {
        const result = await applyGroupControl(interaction, action, scope, groupId);
        return interaction.editReply(componentsV2Payload(baseContainer(interaction.guild, 'GROUP UPDATED', result)));
      }
      if (action === 'rename') {
        flow = newFlow(interaction.guild.id, interaction.user.id, 'rename', groupId);
        return interaction.editReply(flowSelect(interaction.guild, flow, 'RENAME CHANNELS', 'اختر ما تريد إعادة تسميته، ثم أدخل الاسم الجديد.', [{ label: 'Group + Text + Voice', value: 'name', description: 'تغيير اسم القروب والقناتين النصية والصوتية.' }, { label: 'Text Room / Thread', value: 'text', description: 'تغيير اسم القناة النصية أو الثريد فقط.' }, { label: 'Voice Room', value: 'voice', description: 'تغيير اسم القناة الصوتية فقط.' }]));
      }
      if (action === 'permission') {
        flow = newFlow(interaction.guild.id, interaction.user.id, 'permission', groupId);
        return interaction.editReply(scopePayload(interaction.guild, flow));
      }
      choose(action, ['kick', 'allow', 'deny', 'mute', 'unmute']);
      flow = newFlow(interaction.guild.id, interaction.user.id, 'userControl', groupId); flow.action = action;
      if (action === 'kick') {
        flow.scope = 'voice'; flow.step = 'member';
        return interaction.editReply(await voiceMemberSelect(interaction, flow));
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
      return interaction.update(componentsV2Payload(baseContainer(interaction.guild, 'CANCELLED', 'تم إلغاء العملية.')));
    }
    if (flow.busy) {
      return reply(interaction, componentsV2Payload(baseContainer(
        interaction.guild,
        'GROUP ACTION IN PROGRESS',
        'الطلب السابق ما زال قيد التنفيذ؛ انتظر النتيجة ولا تضغط الزر مرة أخرى.'
      )));
    }
    if (step === 'submit' && !interaction.isModalSubmit?.()) throw new Error('INVALID_SELECTION');
    if (step === 'confirm' && !interaction.isButton?.()) throw new Error('INVALID_SELECTION');
    const automaticResourceStep = flow.kind === 'import' && ['no-text', 'no-thread', 'no-voice'].includes(step);
    if (!['submit', 'confirm', 'prev', 'next'].includes(step) && !automaticResourceStep && !interaction.isAnySelectMenu?.()) throw new Error('INVALID_SELECTION');
    const paging = ['prev', 'next'].includes(step) && flow.kind === 'import' && flow.step === 'thread';
    if (step !== flow.step && !paging && !automaticResourceStep) throw new Error('FLOW_EXPIRED');
    if (automaticResourceStep && !['text', 'chat', 'voice'].includes(flow.step)) throw new Error('FLOW_EXPIRED');
    if (flow.kind === 'rename' && step === 'scope') {
      const selected = choose(oneValue(interaction), ['name', 'text', 'voice']);
      await currentManager(interaction, flow.groupId);
      forgetFlow(flow);
      return showRenameModal(interaction, flow.groupId, selected);
    }
    flow.busy = true;
    if (automaticResourceStep) flow.step = step;
    if (interaction.isModalSubmit?.()) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    else await interaction.deferUpdate();
    let payload;
    if (flow.kind === 'import') {
      const settings = await currentSystem(interaction);
      if (step === 'confirm') await interaction.editReply(responsePayload({ title: 'ADDING GROUP', content: 'جارٍ ربط الرول والأعضاء وتجهيز موارد القروب. انتظر اكتمال العملية.', allowedMentions: { parse: [] } }));
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
        payload = componentsV2Payload(baseContainer(interaction.guild, 'GROUP UPDATED', flow.kind === 'limit' ? 'تم تحديث الحد الصوتي لقناة القروب.' : 'تم تحديث الاسم.'));
      } else if (flow.kind === 'userControl') {
        if (step === 'scope') {
          flow.scope = choose(oneValue(interaction), ['text', 'voice', 'both']); flow.step = 'member';
          payload = entitySelect(interaction.guild, flow, `${flow.action.toUpperCase()} MEMBER`, 'اختر عضوًا من القروب.', new UserSelectMenuBuilder().setPlaceholder('اختر عضوًا'));
        } else if (step === 'member') {
          flow.targetId = oneValue(interaction);
          if (flow.memberFilterIds && !flow.memberFilterIds.includes(String(flow.targetId))) throw new Error('INVALID_SELECTION');
          const { settings, group } = await currentManager(interaction, flow.groupId, true);
          await targetMember(interaction, settings, group, flow.targetId, flow.action !== 'allow');
          flow.step = 'confirm';
          const actionLabel = flow.action === 'allow' ? 'السماح' : flow.action === 'deny' ? 'المنع' : 'الفصل';
          const scopeLabel = flow.scope === 'voice' ? 'قناة الفويس' : flow.scope === 'text' ? 'القناة' : 'القناتين النصية والصوتية';
          payload = confirmFlowPayload(interaction.guild, flow, `الإجراء : ${actionLabel}\nالنطاق : ${scopeLabel}\nالعضو : <@${flow.targetId}>`);
        } else if (step === 'confirm' && interaction.isButton?.()) {
          const result = await applyUserControl(interaction, flow, flow.targetId);
          forgetFlow(flow);
          payload = componentsV2Payload(baseContainer(interaction.guild, 'GROUP UPDATED', result));
        } else throw new Error('INVALID_SELECTION');
      } else throw new Error('INVALID_SELECTION');
    }
    return await interaction.editReply({ ...payload, allowedMentions: { parse: [] } });
  } catch (error) {
    if (flow && flow.actorId === interaction.user.id && error.message !== 'ACTION_BUSY') forgetFlow(flow);
    console.error('[groups] scoped action failed:', error);
    const warning = error.groupRollbackFailed ? '\nتنبيه : تعذر التراجع عن بعض التغييرات؛ راجع استثناءات القناة في Discord.' : '';
    const payload = componentsV2Payload(baseContainer(interaction.guild, 'GROUP ACTION FAILED', groupError(error) + warning));
    if (interaction.deferred) return interaction.editReply({ ...payload, allowedMentions: { parse: [] } });
    return reply(interaction, payload);
  } finally { if (flow) flow.busy = false; }
}

module.exports={name,aliases,execute,registerInteractionHandler,handleInternalMessage:dispatchInternalMessage,sendGroupPanel,sendGroupAdminPanel,sendAdminControlPanel,sendMemberControlPanels,sendTopGroupsPanel,buildTopGroupsPayload,selectMemberGroup,buildGroupCommandGuide:groupCommandGuideText,controlPayload,handleInteraction};
