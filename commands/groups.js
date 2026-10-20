const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder, LabelBuilder, ModalBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder, TextDisplayBuilder, SectionBuilder, ContainerBuilder, ThumbnailBuilder, UserSelectMenuBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
const router = require('../utils/interactionRouter');
const gm = require('../utils/groupManager');
const colorManager = require('../utils/colorManager');
const tempVoice = require('./temp');
const { componentsV2Payload, colorToNumber } = require('../utils/structuredContainer');
const { renderMembers, renderInfo, renderTopGroups } = require('../utils/groupRenderer');
const { handleInternalMessage } = require('../utils/groupInternal');
const name = 'groups';
const aliases = ['group', 'قروب', 'قروبات'];
let registered = false;
const locks = new Set();
function safe(s, n=100) { return String(s||'').replace(/[\u0000-\u001f]/g,'').slice(0,n); }
function isOwner(client, member) { return gm.isOwner(client, member); }
function button(id, label, style=ButtonStyle.Secondary, emoji) { const b=new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style); if(emoji)b.setEmoji(emoji); return b; }
function groupThumb(guild) { return guild?.iconURL?.({ extension:'png', size:128 }) || undefined; }
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

function setupPayloads(guild, settings) {
  const status = settings.enabled ? 'مفعل' : 'متوقف';
  const roleMention = id => id ? `<@&${id}>` : 'غير محدد';
  const channelMention = id => id ? `<#${id}>` : 'غير محدد';
  const managerCount = Number(settings.systemUsers?.length || 0) + Number(settings.systemRoles?.length || 0);
  const chatMode = settings.chatMode === 'threads' ? 'ثريدات' : settings.chatMode === 'channels' ? 'رومات مستقلة' : 'غير محدد';
  const summary = `Status : ${status}\nSystem Managers : ${managerCount} عضو/رول\nChat Mode : ${chatMode}\nText Category : ${channelMention(settings.textCategoryId)}\nVoice Category : ${channelMention(settings.voiceCategoryId)}\nTop Channel : ${channelMention(settings.topChannelId)}\nAdmin Control Channel : ${channelMention(settings.adminControlChannelId)}\nMember Control Channel : ${channelMention(settings.memberControlChannelId)}\nMain Role : ${roleMention(settings.mainRoleId)}\nLeader Role : ${roleMention(settings.leaderRoleId)}\nManager Role : ${roleMention(settings.managerRoleId)}\nMusic Source : ${channelMention(settings.musicChannelId)}\nLog Channel : ${channelMention(settings.logChannelId)}\nPoints Scope : ${settings.countAllChannels ? 'كل الرومات' : 'رومات القروبات فقط'}\nExtra Permissions : ${settings.extraPermissions ? 'مفعلة' : 'متوقفة'}\nPoint Rules : اضغط على زر قواعد النقاط للتفاصيل`;
  const sections = [
    ['System Toggle', 'تشغيل أو إيقاف نظام القروبات', 'groups_setup:toggle'],
    ['System Managers', 'إضافة أو إزالة مسؤولي النظام', 'groups_setup:managers'],
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
    ['Extra Permissions', 'تفعيل المسح وأدوات الإدارة', 'groups_setup:extra'],
    ['Point Rules', 'تخصيص قواعد نقاط القروبات', 'groups_setup:rules']
  ];
  const make = (title, items, includeSummary) => {
    const c = includeSummary
      ? baseContainer(guild, title, summary)
      : new ContainerBuilder().setAccentColor(colorToNumber(colorManager.getColor?.() || '#5865F2'));
    for (const [label, desc, id] of items) c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${label}**\n${desc}`)).setButtonAccessory(button(id, 'Open')));
    return componentsV2Payload(c);
  };
  return [make('Group Settings', sections.slice(0, 8), true), make('', sections.slice(8), false)];
}

const setupPanels = new Map();
function rememberSetupPanel(guildId, channelId, first, second) {
  const entry = { guildId: String(guildId), channelId: String(channelId), first, second, touchedAt: Date.now() };
  setupPanels.set(`${entry.guildId}:${entry.channelId}`, entry);
  if (setupPanels.size > 100) setupPanels.delete(setupPanels.keys().next().value);
  return entry;
}
function findSetupPanel(message, guildId, channelId) {
  for (const entry of setupPanels.values()) if (entry.first?.id === message?.id || entry.second?.id === message?.id) return entry;
  return setupPanels.get(`${String(guildId)}:${String(channelId)}`)
    || [...setupPanels.values()].filter(entry => entry.guildId === String(guildId)).sort((a, b) => b.touchedAt - a.touchedAt)[0]
    || null;
}
async function refreshSetupPanel(interaction, settings) {
  settingsCache?.delete(String(interaction.guild.id));
  const entry = findSetupPanel(interaction.message, interaction.guild.id, interaction.channelId);
  if (!entry) return;
  const payloads = setupPayloads(interaction.guild, settings);
  await entry.first?.edit(payloads[0]).catch(() => {});
  await entry.second?.edit(payloads[1]).catch(() => {});
  entry.touchedAt = Date.now();
}
async function sendSetupPanel(channel, guild, settings) {
  const payloads = setupPayloads(guild, settings);
  const first = await channel.send(payloads[0]);
  const second = await channel.send(payloads[1]);
  rememberSetupPanel(guild.id, channel.id, first, second);
  return first;
}
function controlPayload(guild) { const c=baseContainer(guild,'التحكم بالقروب','استخدم الأزرار لإدارة القروبات.'); const items=[['إنشاء قروب','إنشاء قروب جديد','groups_admin:create',ButtonStyle.Success],['استيراد قروب','ربط عناصر Discord موجودة','groups_admin:import',ButtonStyle.Secondary],['حذف قروب','حذف قروب مُدار','groups_admin:delete',ButtonStyle.Danger],['معلومات القروب','عرض تفاصيل القروب','groups_admin:info',ButtonStyle.Secondary],['تعديل قروب','تعديل إعدادات القروب','groups_admin:edit',ButtonStyle.Primary],['تصفير نقاط قروب','تصفير قروب واحد','groups_admin:reset',ButtonStyle.Secondary],['تصفير كل النقاط','تصفير نقاط كل القروبات','groups_admin:resetall',ButtonStyle.Danger]]; for(const [label,desc,id,style] of items)c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${label}**\n${desc}`)).setButtonAccessory(button(id,'فتح',style))); return componentsV2Payload(c); }
function selectPayload(guild, title, description, customId, options) { const c=baseContainer(guild,title,description); const menu=new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('اختر خيارًا').setMinValues(1).setMaxValues(1).addOptions(options); c.addActionRowComponents(new ActionRowBuilder().addComponents(menu)); return componentsV2Payload(c); }
async function reply(interaction, payload, ephemeral=true) { const data={...payload,allowedMentions:{parse:[]}}; if(interaction.deferred&&!interaction.replied)return interaction.editReply(data); if(interaction.replied)return interaction.followUp({...data,ephemeral}); return interaction.reply({...data,ephemeral}); }
async function deny(interaction) { return reply(interaction,{content:'لا تملك صلاحية استخدام هذه العملية.'}); }
function setupConfirmation(interaction, title, text) { const c = baseContainer(interaction.guild, title, `**- ${safe(text, 300)} **`); return componentsV2Payload(c); }
async function checkSystem(interaction) { const settings=await gm.getSettings(interaction.guild.id); if(!gm.canManageSystem(interaction.client,settings,interaction.member)){await deny(interaction);return null;} return settings; }
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
  return new ActionRowBuilder().addComponents(
    button('groups_top:rank', 'My Rank', ButtonStyle.Primary),
    button('groups_top:group', 'قروبي', ButtonStyle.Secondary),
    button('groups_top:refresh', 'Refresh', ButtonStyle.Success)
  );
}
async function buildTopGroupsPayload(guild, { viewerId = null, channelId = null } = {}) {
  const groups = await gm.listGroups(guild.id);
  const selectedGroup = selectMemberGroup(groups, viewerId, channelId);
  const sorted = [...groups].sort((a, b) => Number(b.points || 0) - Number(a.points || 0) || Number(a.id || 0) - Number(b.id || 0));
  const targetGroups = sorted.slice(0, 10);
  if (selectedGroup && !targetGroups.some(group => String(group.id) === String(selectedGroup.id))) targetGroups.push(selectedGroup);
  const memberRowsByGroup = {};
  await Promise.all(targetGroups.map(async group => {
    memberRowsByGroup[String(group.id)] = await gm.listMemberPoints(guild.id, group.id, 1000).catch(() => []);
  }));
  const attachment = await renderTopGroups({ guild, groups, memberRowsByGroup, selectedGroup, viewerId, accentColor: selectedGroup?.color || '#5865F2' });
  const description = selectedGroup ? `Selected group: **${safe(selectedGroup.name)}**\nUse My Rank to see your rank and total points in this group.` : 'Use My Group to select the group you belong to.';
  const container = baseContainer(guild, 'Top Groups', description, selectedGroup?.color || '#5865F2');
  container.addActionRowComponents(topGroupsButtons());
  return { ...componentsV2Payload(container), files: [attachment] };
}
const topPanelLocks = new Map();
async function sendTopGroupsPanel(channel, guild, options = {}) {
  const key = String(channel?.id || guild?.id || 'top-groups');
  if (topPanelLocks.has(key)) return topPanelLocks.get(key);
  const work = (async () => {
    const payload = await buildTopGroupsPayload(guild, { ...options, channelId: options.channelId || channel?.id });
    const messages = await channel?.messages?.fetch?.({ limit: 50 }).catch(() => null);
    const botId = guild?.client?.user?.id;
    const existing = messages && [...messages.values()].find(message => (!botId || message.author?.id === botId) && JSON.stringify(message.components || []).includes('groups_top:'));
    if (existing?.edit) return existing.edit(payload);
    return channel.send(payload);
  })();
  topPanelLocks.set(key, work);
  try { return await work; } finally { topPanelLocks.delete(key); }
}
async function handleTopGroupsInteraction(interaction) {
  const payload = await buildTopGroupsPayload(interaction.guild, { viewerId: interaction.user?.id, channelId: interaction.channelId });
  if (typeof interaction.update === 'function') return interaction.update(payload);
  return reply(interaction, payload, true);
}

async function sendGroupPanel(channel, guild, groupId) {
  const payload = { ...controlGroupPayload(guild, groupId), allowedMentions: { parse: [] } };
  try {
    return await channel.send(payload);
  } catch (error) {
    console.error(`تعذر إرسال Container لوحة القروب ${groupId}:`, error?.stack || error?.message || error);
    const id = Number(groupId);
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
      return await channel.send({ embeds: [new EmbedBuilder().setTitle('التحكم بالقروب').setDescription('استخدم الأزرار لإدارة القروب.').setColor(colorToNumber(colorManager.getColor?.() || '#5865F2'))], components: rows, allowedMentions: { parse: [] } });
    } catch (fallbackError) {
      console.error(`تعذر إرسال لوحة القروب الاحتياطية ${groupId}:`, fallbackError?.stack || fallbackError?.message || fallbackError);
      return null;
    }
  }
}
async function createFromModal(interaction) { const settings=await checkSystem(interaction); if(!settings)return; await interaction.deferReply({flags:MessageFlags.Ephemeral}); const name=safe(interaction.fields.getTextInputValue('group_name'),80); const ownerId=interaction.fields.getTextInputValue('group_owner').match(/\d{16,20}/)?.[0]||interaction.user.id; if(!name)return reply(interaction,{content:'اسم القروب مطلوب.'}); try { const group=await gm.createGroup(interaction.guild,{name,ownerId,color:'#5865F2'},interaction.user.id); await gm.logGroupEvent(interaction.guild,'create',{groupId:group.id,name:group.name,ownerId:group.owner_id},interaction.user.id); const voiceChannel=interaction.guild.channels.cache.get(group.voice_channel_id)||await interaction.guild.channels.fetch(group.voice_channel_id).catch(()=>null); const musicResult=voiceChannel?await tempVoice.ensureMusicBotInVoice(interaction.guild,voiceChannel,{musicChannelId:settings.musicChannelId,reason:'Move music bot to newly created group'}):null; await gm.logGroupEvent(interaction.guild,'music',{groupId:group.id,ok:Boolean(musicResult?.ok),code:musicResult?.code||null},interaction.user.id); const defaultChannel=interaction.guild.channels.cache.get(group.thread_id||group.text_channel_id); const configuredChannel=settings.memberControlChannelId&&interaction.guild.channels.cache.get(settings.memberControlChannelId); const channel=configuredChannel||defaultChannel; if(channel) { if(group.thread_id&&channel.id===group.thread_id) await channel.members.add(ownerId).catch(()=>{}); await sendGroupPanel(channel,interaction.guild,group.id); } await reply(interaction,{content:`تم إنشاء القروب : **${safe(group.name)}**\nالميوزك : ${musicResultMessage(musicResult)}`}); } catch(error){ await reply(interaction,{content:error.message.startsWith('GROUP_SETUP_REQUIRED')?'أكمل إعدادات القروبات أولًا.':`تعذر إنشاء القروب : ${error.message}`}); } }
async function handleSetup(interaction, action) { const settings=await checkSystem(interaction); if(!settings)return true; if(action==='toggle'){const updated=await gm.saveSettings(interaction.guild.id,{enabled:!settings.enabled},interaction.user.id);await refreshSetupPanel(interaction,updated);return reply(interaction,setupConfirmation(interaction,'System Toggle',`تم ${!settings.enabled ? 'تفعيل' : 'إيقاف'} نظام القروبات.`));} if(action==='chatmode')return reply(interaction,selectPayload(interaction.guild,'نمط الشات','اختر طريقة إنشاء مساحات شات القروبات.','groups_setup_select:chatmode',[{label:'ثريدات',value:'threads',description:'روم أب واحد مع ثريدات خاصة'},{label:'رومات',value:'channels',description:'روم نصي مستقل لكل قروب'}])); if(action==='extra'){const updated=await gm.saveSettings(interaction.guild.id,{extraPermissions:!settings.extraPermissions},interaction.user.id);await refreshSetupPanel(interaction,updated);return reply(interaction,setupConfirmation(interaction,'Extra Permissions',`تم ${!settings.extraPermissions ? 'تفعيل' : 'تعطيل'} الصلاحيات الإضافية.`));} if(action==='scope')return reply(interaction,selectPayload(interaction.guild,'نطاق النقاط','اختر أين يتم احتساب تفاعل القروبات.','groups_setup_select:scope',[{label:'رومات القروبات فقط',value:'group',description:'رومات نص وفويس القروبات فقط'},{label:'كل الرومات',value:'all',description:'كل رومات السيرفر المقروءة'}])); if(action==='log'||action==='topchannel'||action==='adminchannel'||action==='memberchannel'){const menu=new ChannelSelectMenuBuilder().setCustomId(`groups_setup_channel:${action}`).setPlaceholder('اختر رومًا نصيًا').setMinValues(1).setMaxValues(1).setChannelTypes(ChannelType.GuildText);const c=baseContainer(interaction.guild,'Channel Settings','اختر رومًا نصيًا واحدًا.');c.addActionRowComponents(new ActionRowBuilder().addComponents(menu));return reply(interaction,componentsV2Payload(c));} if(action==='mainrole'||action==='leaderrole'||action==='managerrole'){const menu=new RoleSelectMenuBuilder().setCustomId(`groups_setup_role:${action}`).setPlaceholder('اختر رولًا').setMinValues(1).setMaxValues(1);const c=baseContainer(interaction.guild,'إعداد الرول','اختر رولًا واحدًا.');c.addActionRowComponents(new ActionRowBuilder().addComponents(menu));return reply(interaction,componentsV2Payload(c));} if(action==='textcat'||action==='voicecat'||action==='music'){const type=action==='textcat'||action==='voicecat'?ChannelType.GuildCategory:ChannelType.GuildVoice;const menu=new ChannelSelectMenuBuilder().setCustomId(`groups_setup_channel:${action}`).setPlaceholder('اختر رومًا').setMinValues(1).setMaxValues(1).setChannelTypes(type);const c=baseContainer(interaction.guild,'إعداد الروم','اختر رومًا واحدًا.');c.addActionRowComponents(new ActionRowBuilder().addComponents(menu));return reply(interaction,componentsV2Payload(c));} if(action==='rules')return reply(interaction,rulesPayload(interaction.guild,await gm.getRules(interaction.guild.id))); if(action==='managers'){const c=baseContainer(interaction.guild,'مسؤولو النظام','أضف أو أزل عضوًا أو رولًا');c.addActionRowComponents(new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('groups_setup_manager:add:user').setPlaceholder('إضافة عضو').setMinValues(1).setMaxValues(5)));c.addActionRowComponents(new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('groups_setup_manager:add:role').setPlaceholder('إضافة رول').setMinValues(1).setMaxValues(5)));const current=[...settings.systemUsers.map(id=>({label:`User ${id}`,value:`user:${id}`,description:'إزالة مسؤول عضو'})),...settings.systemRoles.map(id=>({label:`Role ${id}`,value:`role:${id}`,description:'إزالة مسؤول رول'}))].slice(0,25);if(current.length)c.addActionRowComponents(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('groups_setup_manager:remove').setPlaceholder('إزالة مسؤول').setMinValues(1).setMaxValues(Math.min(25,current.length)).addOptions(current)));return reply(interaction,componentsV2Payload(c));} return reply(interaction,setupConfirmation(interaction,'Group Settings','تم تنفيذ إعداد القروبات.')); }
async function handleAdmin(interaction, action) { const settings=await checkSystem(interaction);if(!settings)return true; if(action==='create'){const modal=new ModalBuilder().setCustomId('groups_modal:create').setTitle('إنشاء قروب');modal.addLabelComponents(new LabelBuilder().setLabel('اسم القروب').setTextInputComponent(new TextInputBuilder().setCustomId('group_name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)));modal.addLabelComponents(new LabelBuilder().setLabel('معرف المالك أو منشنه').setTextInputComponent(new TextInputBuilder().setCustomId('group_owner').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder(interaction.user.id)));return interaction.showModal(modal);} if(action==='delete'||action==='info'||action==='edit'||action==='reset'){const groups=await gm.listGroups(interaction.guild.id); if(!groups.length)return reply(interaction,{content:'لا توجد قروبات نشطة.'});const opts=groups.slice(0,25).map(g=>({label:safe(g.name,90),value:String(g.id),description:`${Number(g.points||0).toLocaleString()} points`}));return reply(interaction,selectPayload(interaction.guild,action==='delete'?'حذف قروب':action==='reset'?'تصفير النقاط':'اختر قروبًا','اختر قروبًا واحدًا.',`groups_admin_select:${action}`,opts));}if(action==='resetall'){const c=baseContainer(interaction.guild,'تصفير كل النقاط','سيتم تصفير نقاط كل القروبات النشطة.');c.addActionRowComponents(new ActionRowBuilder().addComponents(button('groups_admin_confirm:resetall','تأكيد',ButtonStyle.Danger),button('groups_admin_cancel','إلغاء')));return reply(interaction,componentsV2Payload(c));}return true; }
async function handleMember(interaction, action, groupId) { const settings=await gm.getSettings(interaction.guild.id); let group=groupId>0?await gm.getGroup(interaction.guild.id,groupId):null; if(!group){const groups=await gm.listGroups(interaction.guild.id);group=selectMemberGroup(groups,interaction.user.id,interaction.channelId);} if(!group||(!gm.canManageGroup(interaction.client,settings,group,interaction.member)&&!group.memberIds.includes(String(interaction.user.id))))return deny(interaction);if(action==='info'){const owner=await interaction.guild.members.fetch(group.owner_id).catch(()=>null);const managers=await Promise.all(group.managerIds.map(id=>interaction.guild.members.fetch(id).catch(()=>null)));const attachment=await renderInfo({guild:interaction.guild,group,owner,managers:managers.filter(Boolean),accentColor:group.color});return reply(interaction,{files:[attachment]});}return true;}
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

async function handleInteraction(interaction) { const extended=await handleGroupExtensions(interaction); if(extended!==false)return extended; const [prefix,action,...parts]=String(interaction.customId||'').split(':'); if(prefix==='groups_rules_modal'){const metric=parts[0];const settings=await checkSystem(interaction);if(!settings)return true;const definition=RULE_METRICS.find(([key])=>key===metric);if(!definition)return reply(interaction,{content:'قاعدة النقاط غير معروفة.'});try{const rules=await gm.getRules(interaction.guild.id);const current=rules.find(rule=>String(rule.metric)===metric);const threshold=Number(interaction.fields.getTextInputValue('threshold'));const points=Number(interaction.fields.getTextInputValue('points'));await gm.setRule(interaction.guild.id,metric,threshold,points,Number(current?.enabled)===1,interaction.user.id);await gm.logGroupEvent(interaction.guild,'rule_update',{metric,threshold,points,enabled:Number(current?.enabled)===1},interaction.user.id);await refreshSetupPanel(interaction,settings);return reply(interaction,rulesPayload(interaction.guild,await gm.getRules(interaction.guild.id)));}catch(error){return reply(interaction,{content:`تعذر حفظ القاعدة : ${error.message}`});}} if(prefix==='groups_modal'){ if(action==='create') return createFromModal(interaction); if(action==='edit'){if(!await checkSystem(interaction))return true;const groupId=Number(parts[0]);const field=choose(parts[1],['name','description','color','emoji']);const group=await gm.getGroup(interaction.guild.id,groupId);if(!group||group.status!=='active')return reply(interaction,{content:'القروب غير موجود.'});await interaction.deferReply({flags:MessageFlags.Ephemeral});const value=safe(interaction.fields.getTextInputValue('value'),field==='description'?500:field==='name'?80:100).trim();if(field==='name')await renameGroupResources(interaction,group,'name',value);else{if(field==='color'&&!/^#[0-9a-f]{6}$/i.test(value))return reply(interaction,{content:'استخدم لونًا بصيغة ست خانات، مثل #5865F2.'});await gm.updateGroup(interaction.guild.id,groupId,{[field]:value,updated_at:Date.now()},interaction.user.id);}invalidateGroupCaches(interaction.guild.id);await gm.logGroupEvent?.(interaction.guild,'update',{groupId,field,value},interaction.user.id);return reply(interaction,{content:'تم تحديث القروب.'});} return false; } if(prefix==='groups_setup')return handleSetup(interaction,action); if(prefix==='groups_rules')return handleRulesInteraction(interaction,action,parts); if(prefix==='groups_admin')return handleAdmin(interaction,action); if(prefix==='groups_member')return handleMember(interaction,action,Number(parts[0])); if(prefix==='groups_setup_select'){const value=interaction.values?.[0];const settings=await checkSystem(interaction);if(!settings)return true;if(action==='chatmode'){const updated=await gm.saveSettings(interaction.guild.id,{chatMode:value},interaction.user.id);await refreshSetupPanel(interaction,updated);return reply(interaction,setupConfirmation(interaction,'Chat Mode',`تم حفظ نمط الشات : ${value==='threads'?'ثريدات':'رومات مستقلة'}.`));}if(action==='scope'){const updated=await gm.saveSettings(interaction.guild.id,{countAllChannels:value==='all'},interaction.user.id);await refreshSetupPanel(interaction,updated);return reply(interaction,setupConfirmation(interaction,'Points Scope',`تم حفظ نطاق النقاط : ${value==='all'?'كل الرومات':'رومات القروبات فقط'}.`));}return reply(interaction,setupConfirmation(interaction,'Group Settings','تم حفظ الإعداد.'));} if(prefix==='groups_setup_role'){const settings=await checkSystem(interaction);if(!settings)return true;const roleId=interaction.values[0];const patch=action==='mainrole'?{mainRoleId:roleId}:action==='leaderrole'?{leaderRoleId:roleId}:{managerRoleId:roleId};const updated=await gm.saveSettings(interaction.guild.id,patch,interaction.user.id);const label=action==='mainrole'?'Main Role':action==='leaderrole'?'Leader Role':'Manager Role';await refreshSetupPanel(interaction,updated);return reply(interaction,setupConfirmation(interaction,label,`تم حفظ ${label} : <@&${roleId}>.`));} if(prefix==='groups_setup_channel'){const settings=await checkSystem(interaction);if(!settings)return true;const channelId=interaction.values[0];const patch=action==='textcat'?{textCategoryId:channelId}:action==='voicecat'?{voiceCategoryId:channelId}:action==='music'?{musicChannelId:channelId}:action==='topchannel'?{topChannelId:channelId}:action==='adminchannel'?{adminControlChannelId:channelId}:action==='memberchannel'?{memberControlChannelId:channelId}:{logChannelId:channelId};const updated=await gm.saveSettings(interaction.guild.id,patch,interaction.user.id);const label=action==='textcat'?'Text Category':action==='voicecat'?'Voice Category':action==='music'?'Music Source':action==='topchannel'?'Top Channel':action==='adminchannel'?'Admin Control Channel':action==='memberchannel'?'Member Control Channel':'Log Channel';await refreshSetupPanel(interaction,updated);return reply(interaction,setupConfirmation(interaction,label,`تم حفظ ${label} : <#${channelId}>.`));} if(prefix==='groups_setup_manager'){const settings=await checkSystem(interaction);if(!settings)return true;const ids=interaction.values||[];if(action==='remove'){const users=new Set(settings.systemUsers),roles=new Set(settings.systemRoles);for(const value of ids){const [kind,id]=String(value).split(':');(kind==='user'?users:roles).delete(id);}const updated=await gm.saveSettings(interaction.guild.id,{systemUsers:[...users],systemRoles:[...roles]},interaction.user.id);await refreshSetupPanel(interaction,updated);return reply(interaction,setupConfirmation(interaction,'System Managers',`تمت إزالة ${ids.length} مسؤول من مسؤولي النظام.`));}if(action==='add'&&parts[0]==='user'){const updated=await gm.saveSettings(interaction.guild.id,{systemUsers:[...new Set([...settings.systemUsers,...ids])]},interaction.user.id);await refreshSetupPanel(interaction,updated);return reply(interaction,setupConfirmation(interaction,'System Managers',`تمت إضافة ${ids.length} مسؤول عضو.`));}if(action==='add'&&parts[0]==='role'){const updated=await gm.saveSettings(interaction.guild.id,{systemRoles:[...new Set([...settings.systemRoles,...ids])]},interaction.user.id);await refreshSetupPanel(interaction,updated);return reply(interaction,setupConfirmation(interaction,'System Managers',`تمت إضافة ${ids.length} مسؤول رول.`));}return reply(interaction,setupConfirmation(interaction,'System Managers','تم حفظ مسؤولي النظام.'));} if(prefix==='groups_admin_select'){const settings=await checkSystem(interaction);if(!settings)return true;const groupId=Number(interaction.values[0]);if(action==='reset'){await gm.resetPoints(interaction.guild.id,groupId,interaction.user.id);return reply(interaction,{content:'Group points reset.'});}if(action==='delete'){const group=await gm.getGroup(interaction.guild.id,groupId);const c=baseContainer(interaction.guild,'تأكيد الحذف',`القروب : **${safe(group?.name)}**\nسيتم حذف قنوات ورول القروب.`);c.addActionRowComponents(new ActionRowBuilder().addComponents(button(`groups_admin_confirm:delete:${groupId}`,'تأكيد',ButtonStyle.Danger),button('groups_admin_cancel','إلغاء')));return reply(interaction,componentsV2Payload(c));}if(action==='info'){const g=await gm.getGroup(interaction.guild.id,groupId);if(!g)return reply(interaction,{content:'القروب غير موجود.'});const owner=await interaction.guild.members.fetch(g.owner_id).catch(()=>null);const managers=await Promise.all(g.managerIds.map(id=>interaction.guild.members.fetch(id).catch(()=>null)));const attachment=await renderInfo({guild:interaction.guild,group:g,owner,managers:managers.filter(Boolean),accentColor:g.color});return reply(interaction,{files:[attachment]});}if(action==='edit'){return reply(interaction,selectPayload(interaction.guild,'Edit Group','اختر الحقل المطلوب.',`groups_edit_field:${groupId}`,[{label:'الاسم',value:'name'},{label:'الوصف',value:'description'},{label:'اللون',value:'color'},{label:'الإيموجي',value:'emoji'},{label:'المالك',value:'owner'}]));}} if(prefix==='groups_edit_field'){const groupId=Number(action);const field=choose(interaction.values?.[0],['name','description','color','emoji','owner']);if(!await checkSystem(interaction))return true;if(field==='owner'){const menu=new UserSelectMenuBuilder().setCustomId(`groups_edit_owner:${groupId}`).setPlaceholder('Choose new owner').setMinValues(1).setMaxValues(1);const c=baseContainer(interaction.guild,'نقل الملكية','اختر عضوًا حاليًا من القروب.');c.addActionRowComponents(new ActionRowBuilder().addComponents(menu));return reply(interaction,componentsV2Payload(c));}const modal=new ModalBuilder().setCustomId(`groups_modal:edit:${groupId}:${field}`).setTitle(`تعديل ${field}`);modal.addLabelComponents(new LabelBuilder().setLabel(field).setTextInputComponent(new TextInputBuilder().setCustomId('value').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(field==='description'?500:100)));return interaction.showModal(modal);} if(prefix==='groups_edit_owner'){const settings=await checkSystem(interaction);if(!settings)return true;const group=await gm.getGroup(interaction.guild.id,Number(action));const ownerId=interaction.values?.[0];if(!group||!group.memberIds.includes(String(ownerId)))return reply(interaction,{content:'يجب أن يكون المالك الجديد عضوًا في القروب.'});await gm.updateGroup(interaction.guild.id,group.id,{owner_id:ownerId,updated_at:Date.now()},interaction.user.id);const role=settings.leaderRoleId&&interaction.guild.roles.cache.get(settings.leaderRoleId);if(role){const oldOwner=await interaction.guild.members.fetch(group.owner_id).catch(()=>null);const newOwner=await interaction.guild.members.fetch(ownerId).catch(()=>null);if(oldOwner)await oldOwner.roles.remove(role,'نقل ملكية القروب').catch(()=>{});if(newOwner)await newOwner.roles.add(role,'نقل ملكية القروب').catch(()=>{});}await gm.logGroupEvent(interaction.guild,'owner',{groupId:group.id,from:group.owner_id,to:ownerId},interaction.user.id);return reply(interaction,{content:'تم نقل الملكية.'});} if(prefix==='groups_admin_confirm'){const settings=await checkSystem(interaction);if(!settings)return true;if(action==='resetall'){await gm.resetPoints(interaction.guild.id,null,interaction.user.id);return reply(interaction,{content:'تم تصفير نقاط كل القروبات.'});}if(action==='delete'){const deletedGroup=await gm.getGroup(interaction.guild.id,Number(parts[0]));await gm.deleteGroup(interaction.guild,Number(parts[0]),interaction.user.id);await gm.logGroupEvent(interaction.guild,'delete',{groupId:Number(parts[0]),name:deletedGroup?.name||null},interaction.user.id);return reply(interaction,{content:'تم حذف القروب.'});}} if(prefix==='groups_admin_cancel')return reply(interaction,{content:'تم الإلغاء.'}); return false; }
async function execute(message,args,{client}={}) {
  if(!message.guild)return;
  const settings=await gm.getSettings(message.guild.id); const member=message.member; const sub=String(args[0]||'').toLowerCase();
  if(sub==='setup'||sub==='إعدادات'){if(!gm.canManageSystem(client,settings,member))return message.reply('لا تملك الصلاحية.');return sendSetupPanel(message.channel,message.guild,settings);}
  if(sub==='control'||sub==='تحكم'){if(!gm.canManageSystem(client,settings,member))return message.reply('لا تملك الصلاحية.');const target= settings.adminControlChannelId && message.guild.channels.cache.get(settings.adminControlChannelId);return (target||message.channel).send(controlPayload(message.guild));}
  if(['rules','قواعد'].includes(sub)){if(!gm.canManageSystem(client,settings,member))return message.reply('لا تملك الصلاحية.');if(!args[1])return message.channel.send(rulesPayload(message.guild,await gm.getRules(message.guild.id)));const metric=String(args[1]).toLowerCase()==='voice'?'voice_ms':String(args[1]).toLowerCase()==='reaction'||String(args[1]).toLowerCase()==='reactions'?'reactions':'messages';const threshold=Number(args[2]||100);const points=Number(args[3]||1);await gm.setRule(message.guild.id,metric,threshold,points,true,message.author.id);await gm.logGroupEvent(message.guild,'rule_update',{metric,threshold,points,enabled:true},message.author.id);return message.reply(`تم حفظ القاعدة : ${metric} / ${threshold} / ${points}`);}
  if(sub==='create'||sub==='انشاء'||sub==='إنشاء'){if(!gm.canManageSystem(client,settings,member))return message.reply('لا تملك الصلاحية.');return message.channel.send('استخدم لوحة التحكم لإنشاء القروب.');}
  if(['top','leaderboard','ranking','rank','ترتيب','تصنيف'].includes(sub)){const target=settings.topChannelId&&message.guild.channels.cache.get(settings.topChannelId);return sendTopGroupsPanel(target||message.channel,message.guild,{viewerId:message.author.id,channelId:(target||message.channel).id});}
  if(['members','اعضاء'].includes(sub)){const group=selectMemberGroup(await gm.listGroups(message.guild.id),message.author.id,message.channel.id);if(!group)return message.reply('لا يوجد قروب نشط.');const full=await gm.getGroup(message.guild.id,group.id);const rows=await gm.listMemberPoints(message.guild.id,group.id,10);const members=await Promise.all(rows.map(async row=>({ ...row, member:await message.guild.members.fetch(row.user_id).catch(()=>null)})));return message.channel.send({files:[await renderMembers({guild:message.guild,group:full,members,accentColor:full.color})]});}
  return message.reply('استخدم `: groups setup` أو `: groups control`.');
}
const activityCache=new Map(); const settingsCache=new Map(); const voiceStarts=new Map(); const lastMessageAt=new Map();
async function cachedGroups(guildId){const hit=activityCache.get(String(guildId));if(hit&&Date.now()-hit.at<30000)return hit.groups;const groups=await gm.listGroups(guildId);activityCache.set(String(guildId),{at:Date.now(),groups});return groups;}
async function cachedSettings(guildId){const hit=settingsCache.get(String(guildId));if(hit&&Date.now()-hit.at<30000)return hit.settings;const settings=await gm.getSettings(guildId);settingsCache.set(String(guildId),{at:Date.now(),settings});return settings;}
function registerInteractionHandler(client){
  if(registered)return; registered=true;
  router.register('groups_',handleInteraction,{name:'groups',priority:95,types:['button','modal','stringSelect','userSelect','roleSelect','channelSelect']});
  const cleanupTimer=setInterval(async()=>{for(const guild of client.guilds.cache.values()){const groups=await gm.listGroups(guild.id).catch(()=>[]);for(const group of groups){const channel=guild.channels.cache.get(group.text_channel_id||group.thread_id);if(!channel?.messages?.fetch)continue;const messages=await channel.messages.fetch({limit:100}).catch(()=>null);if(!messages)continue;const removable=messages.filter(msg=>!msg.components?.length&&msg.author?.id!==client.user?.id);if(removable.size)await channel.bulkDelete(removable,true).catch(()=>{});}}},180000);cleanupTimer.unref?.();
  client.on('messageCreate',async message=>{if(!message.guild||message.author.bot)return;const settings=await cachedSettings(message.guild.id).catch(()=>null);if(!settings?.enabled)return;const groups=await cachedGroups(message.guild.id);const group=groups.find(g=>g.memberIds.includes(String(message.author.id))||String(g.owner_id)===String(message.author.id));if(!group)return;const key=`${message.guild.id}:${message.author.id}`;const now=Date.now();if(now-Number(lastMessageAt.get(key)||0)<60000)return;lastMessageAt.set(key,now);if(lastMessageAt.size>10000)for(const [k,t] of lastMessageAt)if(now-t>600000)lastMessageAt.delete(k);await gm.recordActivity(message.guild.id,message.author.id,'messages',1,message.channelId).catch(()=>{});});
  client.on('messageReactionAdd',async(reaction,user)=>{if(user?.bot||!reaction?.message?.guild)return;const settings=await cachedSettings(reaction.message.guild.id).catch(()=>null);if(!settings?.enabled)return;const groups=await cachedGroups(reaction.message.guild.id);const group=groups.find(g=>g.memberIds.includes(String(user.id))||String(g.owner_id)===String(user.id));if(group)await gm.recordActivity(reaction.message.guild.id,user.id,'reactions',1,reaction.message.channelId).catch(()=>{});});
  client.on('voiceStateUpdate',async(oldState,newState)=>{const guildId=newState.guild?.id||oldState.guild?.id;if(!guildId)return;const groups=await cachedGroups(guildId);const oldGroup=groups.find(g=>g.voice_channel_id&&g.voice_channel_id===oldState.channelId&& (g.memberIds.includes(String(oldState.id))||String(g.owner_id)===String(oldState.id)));const newGroup=groups.find(g=>g.voice_channel_id&&g.voice_channel_id===newState.channelId&& (g.memberIds.includes(String(newState.id))||String(g.owner_id)===String(newState.id)));const key=`${guildId}:${newState.id}`;if(oldGroup&&(!newGroup||oldGroup.id!==newGroup.id)){const started=voiceStarts.get(key);if(started){await gm.recordActivity(guildId,newState.id,'voice_ms',Date.now()-started,oldState.channelId).catch(()=>{});voiceStarts.delete(key);}}if(newGroup&&!oldGroup)voiceStarts.set(key,Date.now());});
  client.on('channelDelete',async channel=>{if(!channel.guild)return;const groups=await gm.listGroups(channel.guild.id,true);for(const g of groups){const patch={};if(g.text_channel_id===channel.id)patch.text_channel_id=null;if(g.thread_id===channel.id)patch.thread_id=null;if(g.voice_channel_id===channel.id)patch.voice_channel_id=null;if(Object.keys(patch).length){await gm.updateGroup(channel.guild.id,g.id,{...patch,updated_at:Date.now()},null).catch(()=>{});await gm.audit(channel.guild.id,null,g.id,'linked_channel_deleted',{channelId:channel.id}).catch(()=>{});await gm.logGroupEvent(channel.guild,'update',{groupId:g.id,reason:'linked_channel_deleted',channelId:channel.id},null);}}activityCache.delete(String(channel.guild.id));});
  client.on('roleDelete',async role=>{if(!role.guild)return;const groups=await gm.listGroups(role.guild.id,true);for(const g of groups)if(g.role_id===role.id){await gm.updateGroup(role.guild.id,g.id,{role_id:null,updated_at:Date.now()},null).catch(()=>{});await gm.audit(role.guild.id,null,g.id,'linked_role_deleted',{roleId:role.id}).catch(()=>{});await gm.logGroupEvent(role.guild,'update',{groupId:g.id,reason:'linked_role_deleted',roleId:role.id},null);}});
  client.on('guildMemberRemove',async member=>{const groups=await gm.listGroups(member.guild.id);for(const g of groups){if(!g.memberIds.includes(String(member.id))&&String(g.owner_id)!==String(member.id)&&!g.managerIds.includes(String(member.id)))continue;if(String(g.owner_id)===String(member.id)){const successor=g.managerIds.map(id=>member.guild.members.cache.get(id)).find(Boolean)||null;if(successor){await gm.updateGroup(member.guild.id,g.id,{owner_id:successor.id,updated_at:Date.now()},null);const leader=member.guild.roles.cache.get((await gm.getSettings(member.guild.id)).leaderRoleId);if(leader)await successor.roles.add(leader,'نقل ملكية القروب').catch(()=>{});await gm.audit(member.guild.id,successor.id,g.id,'owner_transferred',{from:member.id,to:successor.id});await gm.logGroupEvent(member.guild,'owner',{groupId:g.id,from:member.id,to:successor.id},successor.id);}else{await gm.updateGroup(member.guild.id,g.id,{status:'orphaned',updated_at:Date.now()},null);await gm.audit(member.guild.id,null,g.id,'owner_left',{userId:member.id,status:'orphaned'});await gm.logGroupEvent(member.guild,'owner',{groupId:g.id,from:member.id,status:'orphaned'},null);}continue;}await gm.removeMember(member.guild.id,g.id,member.id,'member_left').catch(()=>{});await gm.logGroupEvent(member.guild,'member_remove',{groupId:g.id,userId:member.id,reason:'member_left'},null);const owner=await member.guild.members.fetch(g.owner_id).catch(()=>null);for(const managerId of g.managerIds){const manager=await member.guild.members.fetch(managerId).catch(()=>null);for(const recipient of [owner,manager])if(recipient)recipient.send(`Group update\nMember: <@${member.id}>\nGroup: **${safe(g.name)}**\nAction: member left`).catch(()=>{});}}});
  client.on('guildMemberUpdate',async(oldMember,newMember)=>{if(oldMember.roles.cache.equals(newMember.roles.cache))return;const groups=await gm.listGroups(newMember.guild.id);for(const g of groups){if(!g.role_id)continue;const had=oldMember.roles.cache.has(g.role_id);const has=newMember.roles.cache.has(g.role_id);const bypass=global.groupRoleGrantBypass?.has(`${newMember.guild.id}:${newMember.id}:${g.role_id}`);const isLinked=g.memberIds.includes(String(newMember.id))||String(g.owner_id)===String(newMember.id)||g.managerIds.includes(String(newMember.id));if(has&&!had&&!isLinked&&!bypass){await newMember.roles.remove(g.role_id,'Unapproved group role assignment').catch(()=>{});await gm.audit(newMember.guild.id,null,g.id,'role_guard_removed',{userId:newMember.id,roleId:g.role_id});await gm.logGroupEvent(newMember.guild,'update',{groupId:g.id,reason:'role_guard_removed',userId:newMember.id,roleId:g.role_id},null);}if(!has&&had&&isLinked&&String(g.owner_id)!==String(newMember.id)){await gm.removeMember(newMember.guild.id,g.id,newMember.id,'role_removed').catch(()=>{});await gm.logGroupEvent(newMember.guild,'member_remove',{groupId:g.id,userId:newMember.id,reason:'role_removed'},null);const owner=await newMember.guild.members.fetch(g.owner_id).catch(()=>null);for(const managerId of g.managerIds){const manager=await newMember.guild.members.fetch(managerId).catch(()=>null);for(const recipient of [owner,manager])if(recipient)recipient.send(`Group update\nMember: <@${newMember.id}>\nGroup: **${safe(g.name)}**\nAction: role removed`).catch(()=>{});}}}});
}
async function dispatchInternalMessage(message, options = {}) {
  const prefix=options.prefix||':';
  if(message?.guild&&!message.author?.bot&&String(message.content||'').startsWith(prefix)) {
    const command=String(message.content).slice(prefix.length).trim().split(/\s+/)[0].toLowerCase();
    if(command==='صلاحية'||command==='permission') {
      try {
        const linked=await gm.getGroupForChannel(message.guild.id,message.channel.id);
        if(!linked)throw new Error('GROUP_NOT_FOUND');
        const {group}=await currentManager(message,linked.id,true);
        const flow=newFlow(message.guild.id,message.author.id,'permission',group.id);
        await message.reply({...scopePayload(message.guild,flow),allowedMentions:{parse:[]}});
      } catch(error) { await message.reply({content:groupError(error),allowedMentions:{parse:[]}}).catch(()=>null); }
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
  const c = baseContainer(guild, 'التحكم بالقروب', 'التحكم متاح لمالك القروب ومسؤوليه. الكتم والطرد والصلاحيات تتطلب الصلاحيات الإضافية.\nالأوامر : تحكم • : تعديل القروب • : عقوبه • : صلاحية • : مسح • : اعضاء\n: اضافة • : ازالة • : منع • : سماح • : قروبي • : مسؤول');
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
    const channels = await groupChannels(interaction.guild, group, flow.scope);
    const allowed = flow.action === 'allow';
    const thread = flow.scope !== 'voice' && group.thread_id ? await channelById(interaction.guild, group.thread_id) : null;
    if (thread?.archived && allowed) throw new Error('THREAD_ARCHIVED');
    if (allowed && flow.scope === 'both' && !group.memberIds.includes(userId) && group.memberIds.length >= settings.maxMembers) throw new Error('GROUP_FULL');
    let wasThreadMember = false;
    let changedThread = false;
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
          await dbManager.transaction(async tx => {
            const row = await tx.get('SELECT * FROM managed_groups WHERE guild_id = ? AND id = ?', [interaction.guild.id, group.id]);
            if (!row || row.status !== 'active') throw new Error('GROUP_NOT_FOUND');
            const members = JSON.parse(row.member_ids_json || '[]');
            const blocked = JSON.parse(row.blocked_ids_json || '[]');
            const managers = JSON.parse(row.manager_ids_json || '[]');
            if (!allowed && (row.owner_id === target.id || managers.includes(target.id))) throw new Error('TARGET_PROTECTED');
            if (allowed && !members.includes(target.id) && members.length >= settings.maxMembers) throw new Error('GROUP_FULL');
            const now = Date.now();
            await tx.run('UPDATE managed_groups SET member_ids_json = ?, blocked_ids_json = ?, updated_at = ? WHERE guild_id = ? AND id = ?', [JSON.stringify(allowed ? [...new Set([...members, target.id])] : members.filter(id => id !== target.id)), JSON.stringify(allowed ? blocked.filter(id => id !== target.id) : [...new Set([...blocked, target.id])]), now, interaction.guild.id, group.id]);
            await tx.run('INSERT INTO group_audit_log(guild_id,group_id,actor_id,action,details_json,created_at) VALUES(?,?,?,?,?,?)', [interaction.guild.id, group.id, interaction.user.id, `control_${flow.action}`, JSON.stringify({ scope: flow.scope, userId: target.id }), now]);
          }, 'group-access-control');
        } else await gm.audit(interaction.guild.id, interaction.user.id, group.id, `control_${flow.action}`, { scope: flow.scope, userId: target.id });
      });
    } catch (error) {
      if (changedThread) await (wasThreadMember ? thread.members.add(target.id) : thread.members.remove(target.id)).catch(() => { error.groupRollbackFailed = true; });
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

module.exports={name,aliases,execute,registerInteractionHandler,handleInternalMessage:dispatchInternalMessage,sendGroupPanel,sendTopGroupsPanel,buildTopGroupsPayload,selectMemberGroup};
