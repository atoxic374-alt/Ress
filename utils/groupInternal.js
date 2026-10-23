const gm = require('./groupManager');
const { renderMembers, renderInfo } = require('./groupRenderer');
const { ActionRowBuilder, PermissionsBitField, UserSelectMenuBuilder } = require('discord.js');
const { randomBytes } = require('node:crypto');
const { responsePayload } = require('./groupResponses');
const colorManager = require('./colorManager');

const COMMANDS = new Set(['تحكم', 'control', 'تعديل', 'edit', 'عقوبه', 'عقوبة', 'punish', 'صلاحية', 'permission', 'مسح', 'clear', 'اعضاء', 'أعضاء', 'members', 'اضافة', 'إضافة', 'اضف', 'أضف', 'ضيف', 'ضم', 'ادخل', 'add', 'invite', 'join', 'add-member', 'addmember', 'ازالة', 'إزالة', 'ازاله', 'إزاله', 'احذف', 'حذف', 'شيل', 'شطب', 'remove', 'remove-member', 'removemember', 'منع', 'block', 'سماح', 'allow', 'قروبي', 'قربي', 'my-group', 'مسؤول', 'manager', 'أوامر', 'اوامر', 'commands', 'help']);
const memberPickerFlows = new Map();
const MEMBER_PICKER_TTL = 10 * 60 * 1000;

function ids(message) {
  return [...new Set([...message.mentions.users.keys(), ...(String(message.content).match(/\b\d{16,20}\b/g) || [])])];
}
function groupHasUser(group, userId) {
  const id = String(userId);
  return String(group.owner_id) === id || group.memberIds.includes(id) || group.managerIds.includes(id);
}
async function syncMember(group, guild, userId, add, { ignoreMissing = false } = {}) {
  const member = await guild.members.fetch(String(userId)).catch(() => null);
  if (!member) throw new Error('MEMBER_NOT_FOUND');
  let role = null;
  if (group.role_id) {
    role = guild.roles.cache.get(group.role_id) || await guild.roles.fetch(group.role_id).catch(() => null);
    if (!role && (!ignoreMissing || add)) throw new Error('GROUP_ROLE_NOT_FOUND');
  }
  let thread = null;
  if (group.thread_id) {
    thread = guild.channels.cache.get(group.thread_id) || await guild.channels.fetch(group.thread_id).catch(() => null);
    if ((!thread?.isThread?.() || !thread.members) && (!ignoreMissing || add)) throw new Error('GROUP_THREAD_NOT_FOUND');
    if (!thread?.isThread?.() || !thread.members) thread = null;
  }
  const wasRoleMember = Boolean(role && member.roles.cache.has(role.id));
  const wasThreadMember = Boolean(thread && await thread.members.fetch(member.id).catch(() => null));
  let changedRole = false;
  let changedThread = false;
  try {
    if (add) {
      if (role && !wasRoleMember) { await member.roles.add(role, 'Managed group membership'); changedRole = true; }
      if (thread && !wasThreadMember) { await thread.members.add(member.id); changedThread = true; }
    } else {
      if (thread && wasThreadMember) { await thread.members.remove(member.id); changedThread = true; }
      if (role && wasRoleMember) { await member.roles.remove(role, 'Managed group membership'); changedRole = true; }
    }
  } catch (error) {
    if (changedThread) await (add ? thread.members.remove(member.id) : thread.members.add(member.id)).catch(() => { error.groupRollbackFailed = true; });
    if (changedRole) await (add ? member.roles.remove(role, 'Rollback group membership') : member.roles.add(role, 'Rollback group membership')).catch(() => { error.groupRollbackFailed = true; });
    throw error;
  }
  return member;
}
function reply(message, content) { const payload = typeof content === 'string' ? responsePayload({ content }) : responsePayload(content); return message.reply(payload).catch(() => null); }
function memberPickerAction(command) {
  if (['اضافة', 'إضافة', 'اضف', 'أضف', 'ضيف', 'ضم', 'ادخل', 'add', 'invite', 'join', 'add-member', 'addmember'].includes(command)) return 'add';
  if (['ازالة', 'إزالة', 'ازاله', 'إزاله', 'احذف', 'حذف', 'شيل', 'شطب', 'remove', 'remove-member', 'removemember'].includes(command)) return 'remove';
  return null;
}
async function openMemberPicker(message, group, action) {
  for (const [token, flow] of memberPickerFlows) if (flow.expires <= Date.now()) memberPickerFlows.delete(token);
  const token = randomBytes(12).toString('hex');
  memberPickerFlows.set(token, { guildId: String(message.guild.id), groupId: Number(group.id), actorId: String(message.author.id), action, expires: Date.now() + MEMBER_PICKER_TTL });
  const menu = new UserSelectMenuBuilder()
    .setCustomId(`groups_member_picker:${action}:${group.id}:${token}`)
    .setPlaceholder(action === 'add' ? 'ابحث واختر الأعضاء المراد إضافتهم' : 'ابحث واختر الأعضاء المراد إزالتهم')
    .setMinValues(1)
    .setMaxValues(25);
  const title = action === 'add' ? 'ADD MEMBERS' : 'REMOVE MEMBERS';
  const description = action === 'add'
    ? 'ابحث عن الأعضاء واختر حتى 25 عضوًا لإضافتهم دفعة واحدة إلى القروب.'
    : 'ابحث عن الأعضاء واختر حتى 25 عضوًا لإزالتهم دفعة واحدة من القروب.';
  return reply(message, responsePayload({ title, content: description, components: [new ActionRowBuilder().addComponents(menu)] }));
}
async function handleMemberPickerInteraction(interaction) {
  const parts = String(interaction.customId || '').split(':');
  if (parts[0] !== 'groups_member_picker') return false;
  const [, action, groupIdRaw, token] = parts;
  const flow = memberPickerFlows.get(token);
  if (!flow || flow.expires <= Date.now() || flow.guildId !== String(interaction.guild?.id)) {
    await interaction.reply(responsePayload({ title: 'PICKER EXPIRED', content: 'انتهت صلاحية قائمة الأعضاء؛ أعد كتابة الأمر لفتح قائمة جديدة.' })).catch(() => {});
    return true;
  }
  if (flow.actorId !== String(interaction.user?.id)) {
    await interaction.reply(responsePayload({ title: 'ACCESS DENIED', content: 'هذه القائمة مخصصة للشخص الذي فتحها.' })).catch(() => {});
    return true;
  }
  if (!interaction.isUserSelectMenu?.()) return true;
  memberPickerFlows.delete(token);
  try {
    const settings = await gm.getSettings(interaction.guild.id);
    const group = await gm.getGroup(interaction.guild.id, Number(groupIdRaw));
    if (!group || group.status !== 'active') throw new Error('GROUP_NOT_FOUND');
    if (!gm.canManageGroup(interaction.client, settings, group, interaction.member)) throw new Error('NO_PERMISSION');
    const success = [], skipped = [], failed = [];
    for (const userId of [...new Set((interaction.values || []).map(String))].slice(0, 25)) {
      const member = await interaction.guild.members.fetch(userId).catch(() => null);
      if (!member || member.user?.bot) { failed.push(`<@${userId}> : العضو غير موجود أو بوت`); continue; }
      const already = groupHasUser(group, userId);
      try {
        if (action === 'add') {
          if (already) { skipped.push(`<@${userId}> : موجود مسبقًا`); continue; }
          if (group.blockedIds.includes(userId)) { failed.push(`<@${userId}> : ممنوع من القروب`); continue; }
          await gm.addMember(interaction.guild.id, group.id, userId, interaction.user.id);
          try { await syncMember(group, interaction.guild, userId, true); }
          catch (error) { await gm.removeMember(interaction.guild.id, group.id, userId, interaction.user.id).catch(() => { error.groupRollbackFailed = true; }); throw error; }
          success.push(`<@${userId}>`);
        } else {
          if (!already) { skipped.push(`<@${userId}> : ليس عضوًا في القروب`); continue; }
          if (String(group.owner_id) === userId) { failed.push(`<@${userId}> : لا يمكن إزالة المالك`); continue; }
          const wasManager = group.managerIds.includes(userId);
          await gm.removeMember(interaction.guild.id, group.id, userId, interaction.user.id);
          try { await syncMember(group, interaction.guild, userId, false); await syncManagerRole(interaction.guild, settings, userId); }
          catch (error) { await restoreMembership(group, interaction.guild.id, userId, wasManager, interaction.user.id).catch(() => { error.groupRollbackFailed = true; }); throw error; }
          success.push(`<@${userId}>`);
        }
      } catch (error) { failed.push(`<@${userId}> : ${error.message === 'GROUP_FULL' ? 'القروب ممتلئ' : 'تعذر تنفيذ العملية'}`); }
    }
    const actionText = action === 'add' ? 'الإضافة' : 'الإزالة';
    const lines = [`تمت ${actionText} الجماعية.`, `نجح : ${success.length}`, `تجاوز : ${skipped.length}`, `فشل : ${failed.length}`];
    if (success.length) lines.push('', `**تم التنفيذ:** ${success.join('، ')}`);
    if (skipped.length) lines.push('', `**تم التجاوز:** ${skipped.join('، ')}`);
    if (failed.length) lines.push('', `**فشل:** ${failed.join('، ')}`);
    await interaction.reply(responsePayload({ title: action === 'add' ? 'MEMBERS ADDED' : 'MEMBERS REMOVED', content: lines.join('\n') })).catch(() => {});
  } catch (error) {
    const content = error.message === 'NO_PERMISSION' ? 'لا تملك صلاحية إدارة أعضاء هذا القروب.' : error.message === 'GROUP_NOT_FOUND' ? 'القروب غير موجود أو غير نشط.' : 'تعذر تنفيذ العملية الجماعية.';
    await interaction.reply(responsePayload({ title: 'REQUEST FAILED', content })).catch(() => {});
  }
  return true;
}
async function restoreMembership(group, guildId, userId, wasManager, actorId) {
  await gm.addMember(guildId, group.id, userId, actorId);
  if (wasManager) await gm.setManagers(guildId, group.id, [...group.managerIds, String(userId)], actorId);
}
async function syncManagerRole(guild, settings, userId, { ignoreMissing = false } = {}) {
  if (!settings.managerRoleId) return;
  const member = await guild.members.fetch(String(userId)).catch(() => null);
  if (!member) throw new Error('MEMBER_NOT_FOUND');
  const role = guild.roles.cache.get(settings.managerRoleId) || await guild.roles.fetch(settings.managerRoleId).catch(() => null);
  if (!role) {
    if (ignoreMissing) return;
    throw new Error('MANAGER_ROLE_NOT_FOUND');
  }
  const groups = await gm.listGroups(guild.id);
  const shouldHaveRole = groups.some(group => group.managerIds.includes(String(userId)));
  const hasRole = member.roles.cache.has(role.id);
  if (shouldHaveRole && !hasRole) await member.roles.add(role, 'Group manager role');
  else if (!shouldHaveRole && hasRole) await member.roles.remove(role, 'Group manager role');
}
async function leaveGroupMember(guild, settings, group, userId, actorId = userId) {
  const id = String(userId);
  if (String(group.owner_id) === id) throw new Error('OWNER_PROTECTED');
  const wasMember = group.memberIds.includes(id);
  const wasManager = group.managerIds.includes(id);
  await gm.removeMember(guild.id, group.id, id, actorId);
  if (!global.groupLeaveRoleBypass) global.groupLeaveRoleBypass = new Set();
  const bypassKey = `${guild.id}:${id}:${group.role_id || 'no-role'}`;
  global.groupLeaveRoleBypass.add(bypassKey);
  try {
    await syncMember(group, guild, id, false, { ignoreMissing: true });
    await syncManagerRole(guild, settings, id, { ignoreMissing: true });
  } catch (error) {
    if (wasMember || wasManager) {
      await restoreMembership(group, guild.id, id, wasManager, actorId).catch(() => { error.groupRollbackFailed = true; });
      await syncMember(group, guild, id, true).catch(() => { error.groupRollbackFailed = true; });
    }
    await syncManagerRole(guild, settings, id, { ignoreMissing: true }).catch(() => { error.groupRollbackFailed = true; });
    throw error;
  } finally {
    global.groupLeaveRoleBypass.delete(bypassKey);
  }
  await gm.logGroupEvent(guild, 'member_remove', { groupId: group.id, userId: id, reason: 'left' }, actorId).catch(() => null);
  return true;
}
async function handleInternalMessage(message, { prefix = ':', sendPanel = null } = {}) {
  if (!message?.guild || message.author?.bot) return false;
  const content = String(message.content || '').trim();
  const hasPrefix = typeof prefix === 'string' && prefix.length > 0 && content.startsWith(prefix);
  const raw = (hasPrefix ? content.slice(prefix.length) : content).trim();
  const words = raw.split(/\s+/);
  let command = String(words.shift() || '').toLowerCase();
  if (command === 'تعديل' && String(words[0] || '') === 'القروب') { command = 'تعديل'; words.shift(); }
  if (!COMMANDS.has(command)) return false;
  // Commands are prefix-free; destructive actions remain protected by the
  // existing role, group-membership, and bot-permission checks.
  let group = await gm.getGroupForChannel(message.guild.id, message.channel.id);
  if (!group || group.status !== 'active') {
    if (hasPrefix) { await reply(message, 'هذا الشات غير مرتبط بقروب نشط.'); return true; }
    const channelScopedCommands = new Set([
      'منع', 'block', 'سماح', 'allow', 'اضافة', 'إضافة', 'add',
      'ازالة', 'إزالة', 'remove', 'مسؤول', 'manager', 'عقوبه', 'عقوبة', 'punish',
      'مسح', 'clear', 'تعديل', 'edit', 'صلاحية', 'permission'
    ]);
    if (channelScopedCommands.has(command)) {
      await reply(message, 'هذا الأمر يحتاج قناة أو ثريد قروب نشطًا. افتح لوحة القروب باستخدام setup أو groups، ثم نفّذ الأمر داخل قناة القروب المرتبطة.');
      return true;
    }
    return false;
  }
  const settings = await gm.getSettings(message.guild.id);
  const privileged = gm.canManageGroup(message.client, settings, group, message.member);
  const system = gm.canManageSystem(message.client, settings, message.member);
  const targetId = ids(message)[0];
  try {
    if (command === 'قروبي' || command === 'قربي' || command === 'my-group') {
      if (!groupHasUser(group, message.author.id) && !system) return Boolean(await reply(message, 'أنت لست عضوًا في القروب.'));
      const owner = await message.guild.members.fetch(group.owner_id).catch(() => null);
      const managers = await Promise.all(group.managerIds.map(id => message.guild.members.fetch(id).catch(() => null)));
      await message.reply(responsePayload({ title: 'GROUP OVERVIEW', content: `القروب : ${group.name}\nهذه معلومات القروب الحالية.`, files: [await renderInfo({ guild: message.guild, group, owner, managers: managers.filter(Boolean), accentColor: null })] })).catch(() => {});
      return true;
    }
    if (command === 'اعضاء' || command === 'أعضاء' || command === 'members') {
      if (!groupHasUser(group, message.author.id) && !system) return Boolean(await reply(message, 'عرض الأعضاء متاح لأعضاء القروب فقط.'));
      const rows = await gm.listMemberPoints(message.guild.id, group.id, 10);
      const members = await Promise.all(rows.map(async row => ({ ...row, member: await message.guild.members.fetch(row.user_id).catch(() => null) })));
      await message.reply(responsePayload({ title: 'GROUP MEMBERS', content: `القروب : ${group.name}\nترتيب الأعضاء حسب النقاط والرسائل.`, files: [await renderMembers({ guild: message.guild, group, members, accentColor: null })] })).catch(() => {});
      return true;
    }
    if (['أوامر', 'اوامر', 'commands', 'help'].includes(command)) {
      if (!groupHasUser(group, message.author.id) && !system) return Boolean(await reply(message, 'دليل الأوامر متاح لأعضاء القروب فقط.'));
      const { buildGroupCommandGuide } = require('../commands/groups');
      await reply(message, { title: 'GROUP COMMANDS', content: buildGroupCommandGuide(group, settings), accentColor: colorManager.getColor?.() });
      return true;
    }
    if (!privileged && !system) { await reply(message, 'لا تملك الصلاحية.'); return true; }
    if (memberPickerAction(command) === 'add') {
      if (!targetId) return Boolean(await openMemberPicker(message, group, 'add'));
      const target = await message.guild.members.fetch(targetId).catch(() => null);
      if (!target) throw new Error('MEMBER_NOT_FOUND');
      if (target.user?.bot) throw new Error('BOT_NOT_ALLOWED');
      const wasMember = groupHasUser(group, targetId);
      if (wasMember) { await reply(message, 'العضو موجود بالفعل في القروب.'); return true; }
      await gm.addMember(message.guild.id, group.id, targetId, message.author.id);
      try { await syncMember(group, message.guild, targetId, true); }
      catch (error) { if (!wasMember) await gm.removeMember(message.guild.id, group.id, targetId, message.author.id).catch(() => { error.groupRollbackFailed = true; }); throw error; }
      await gm.logGroupEvent(message.guild, 'member_add', { groupId: group.id, userId: targetId }, message.author.id);
      await reply(message, 'تمت إضافة العضو.'); return true;
    }
    if (memberPickerAction(command) === 'remove') {
      if (!targetId) return Boolean(await openMemberPicker(message, group, 'remove'));
      if (String(group.owner_id) === String(targetId)) throw new Error('OWNER_PROTECTED');
      const wasManager = group.managerIds.includes(String(targetId));
      if (wasManager && String(group.owner_id) !== String(message.author.id) && !system) throw new Error('MANAGER_PROTECTED');
      const wasMember = groupHasUser(group, targetId);
      if (!wasMember) { await reply(message, 'العضو ليس ضمن هذا القروب.'); return true; }
      await gm.removeMember(message.guild.id, group.id, targetId, message.author.id);
      try { await syncMember(group, message.guild, targetId, false); await syncManagerRole(message.guild, settings, targetId); }
      catch (error) {
        if (wasMember) {
          await restoreMembership(group, message.guild.id, targetId, wasManager, message.author.id).catch(() => { error.groupRollbackFailed = true; });
          await syncMember(group, message.guild, targetId, true).catch(() => { error.groupRollbackFailed = true; });
        }
        await syncManagerRole(message.guild, settings, targetId).catch(() => { error.groupRollbackFailed = true; });
        throw error;
      }
      await gm.logGroupEvent(message.guild, 'member_remove', { groupId: group.id, userId: targetId }, message.author.id);
      await reply(message, 'تمت إزالة العضو.'); return true;
    }
    if (command === 'منع' || command === 'block') {
      if (!targetId) throw new Error('MENTION_REQUIRED');
      if (String(group.owner_id) === String(targetId)) throw new Error('OWNER_PROTECTED');
      const wasManager = group.managerIds.includes(String(targetId));
      if (wasManager && String(group.owner_id) !== String(message.author.id) && !system) throw new Error('MANAGER_PROTECTED');
      if (group.blockedIds.includes(String(targetId))) { await reply(message, 'العضو ممنوع بالفعل من القروب.'); return true; }
      const wasMember = groupHasUser(group, targetId);
      await gm.setBlocked(message.guild.id, group.id, targetId, true, message.author.id);
      try { await syncMember(group, message.guild, targetId, false); await syncManagerRole(message.guild, settings, targetId); }
      catch (error) {
        await gm.setBlocked(message.guild.id, group.id, targetId, false, message.author.id).catch(() => { error.groupRollbackFailed = true; });
        if (wasMember) await restoreMembership(group, message.guild.id, targetId, wasManager, message.author.id).catch(() => { error.groupRollbackFailed = true; });
        if (wasMember) await syncMember(group, message.guild, targetId, true).catch(() => { error.groupRollbackFailed = true; });
        await syncManagerRole(message.guild, settings, targetId).catch(() => { error.groupRollbackFailed = true; });
        throw error;
      }
      await gm.logGroupEvent(message.guild, 'block', { groupId: group.id, userId: targetId }, message.author.id);
      await reply(message, 'تم منع العضو.'); return true;
    }
    if (command === 'سماح' || command === 'allow') {
      if (!targetId) throw new Error('MENTION_REQUIRED');
      const userId = String(targetId);
      if (!group.blockedIds.includes(userId)) { await reply(message, 'العضو غير ممنوع من القروب أصلًا.'); return true; }
      const wasMember = group.memberIds.includes(userId);
      await gm.setBlocked(message.guild.id, group.id, userId, false, message.author.id);
      try {
        // Keep the text command contract identical to the panel's Allow action:
        // restore database membership and Discord role/thread access together.
        if (!wasMember) await gm.addMember(message.guild.id, group.id, userId, message.author.id);
        await syncMember(group, message.guild, userId, true);
      } catch (error) {
        if (!wasMember) await gm.removeMember(message.guild.id, group.id, userId, message.author.id).catch(() => { error.groupRollbackFailed = true; });
        await gm.setBlocked(message.guild.id, group.id, userId, true, message.author.id).catch(() => { error.groupRollbackFailed = true; });
        throw error;
      }
      await gm.logGroupEvent(message.guild, 'unblock', { groupId: group.id, userId, restoredAccess: true }, message.author.id);
      await reply(message, 'تم السماح للعضو وإعادة وصوله للقروب.'); return true;
    }
    if (command === 'مسؤول' || command === 'manager') {
      if (!targetId) throw new Error('MENTION_REQUIRED');
      // Only the group owner can appoint or remove group managers. System
      // managers may administer the system, but cannot change this group role.
      if (String(group.owner_id) !== String(message.author.id)) throw new Error('OWNER_ONLY');
      const target = await message.guild.members.fetch(targetId).catch(() => null);
      if (!target || target.user?.bot) throw new Error('MEMBER_NOT_FOUND');
      const remove = ['remove', 'ازالة', 'إزالة'].includes(String(words[0] || '').toLowerCase());
      const managers = new Set(group.managerIds);
      if (remove) managers.delete(String(targetId));
      else { if (!group.memberIds.includes(String(targetId))) throw new Error('MANAGER_MUST_BE_MEMBER'); managers.add(String(targetId)); }
      const previous = [...group.managerIds];
      const updated = await gm.setManagers(message.guild.id, group.id, [...managers], message.author.id);
      try {
        await syncManagerRole(message.guild, settings, targetId);
      } catch (error) { await gm.setManagers(message.guild.id, group.id, previous, message.author.id).catch(() => { error.groupRollbackFailed = true; }); throw error; }
      await gm.logGroupEvent(message.guild, 'manager_update', { groupId: group.id, managerIds: updated }, message.author.id);
      await reply(message, 'تم تحديث مسؤولي القروب.'); return true;
    }
    if (command === 'مسح' || command === 'clear') {
      if (!settings.extraPermissions) throw new Error('EXTRA_DISABLED');
      const fetched = await message.channel.messages.fetch({ limit: 100 });
      await message.channel.bulkDelete(fetched, true);
      const done = await reply(message, 'تم مسح الرسائل.');
      if (done) setTimeout(() => done.delete().catch(() => {}), 3000);
      return true;
    }
    if (command === 'عقوبه' || command === 'عقوبة' || command === 'punish') {
      if (!settings.extraPermissions) throw new Error('EXTRA_DISABLED');
      if (!targetId) throw new Error('MENTION_REQUIRED');
      const target = await message.guild.members.fetch(targetId).catch(() => null);
      if (!target || target.user?.bot) throw new Error('MEMBER_NOT_FOUND');
      if (!groupHasUser(group, target.id)) throw new Error('TARGET_NOT_IN_GROUP');
      const protectedTarget = String(group.owner_id) === target.id || group.managerIds.includes(target.id)
        || target.id === message.guild.ownerId || gm.isSystemManager(settings, target)
        || target.permissions?.has(PermissionsBitField.Flags.Administrator);
      if (protectedTarget) throw new Error('TARGET_PROTECTED');
      const me = message.guild.members.me || await message.guild.members.fetchMe();
      if (!me.permissions.has(PermissionsBitField.Flags.ModerateMembers)) throw new Error('MISSING_MODERATE_MEMBERS');
      if (target.roles.highest.position >= me.roles.highest.position) throw new Error('TARGET_HIERARCHY');
      await target.timeout(10 * 60 * 1000, `Group punishment by ${message.author.id}`);
      await gm.audit(message.guild.id, message.author.id, group.id, 'control_punish', { userId: target.id, durationMs: 10 * 60 * 1000 });
      await reply(message, 'تم تطبيق عقوبة 10 دقائق.'); return true;
    }
    if (command === 'صلاحية' || command === 'permission') { await reply(message, 'استخدم رول القروب للتحكم بالوصول.'); return true; }
    if (command === 'تحكم' || command === 'control') { if (typeof sendPanel === 'function') await sendPanel(message.channel, message.guild, group.id); else await reply(message, 'لوحة التحكم غير متاحة.'); return true; }
    if (command === 'تعديل' || command === 'edit') { await reply(message, 'استخدم لوحة التحكم لتعديل القروب.'); return true; }
  } catch (error) {
    const messages = {
      MENTION_REQUIRED: 'اذكر عضوًا أولًا.', OWNER_ONLY: 'هذه العملية للمالك فقط.', OWNER_PROTECTED: 'لا يمكن إزالة أو منع مالك القروب.',
      MANAGER_MUST_BE_MEMBER: 'يجب أن يكون المسؤول عضوًا في القروب.', MANAGER_PROTECTED: 'لا يمكن لمدير القروب إزالة مدير آخر أو منعه؛ استخدم مسار إدارة المسؤولين بصلاحية المالك.', EXTRA_DISABLED: 'الصلاحيات الإضافية متوقفة.',
      MEMBER_NOT_FOUND: 'العضو غير موجود في السيرفر.', GROUP_ROLE_NOT_FOUND: 'رتبة القروب المرتبطة غير موجودة.',
      GROUP_THREAD_NOT_FOUND: 'ثريد القروب المرتبط غير موجود.', USER_BLOCKED: 'هذا العضو ممنوع من القروب.',
      USER_ALREADY_IN_GROUP: 'العضو مرتبط بقروب آخر بالفعل.', GROUP_FULL: 'وصل القروب إلى الحد الأقصى للأعضاء.',
      BOT_NOT_ALLOWED: 'لا يمكن إضافة بوت كعضو في القروب.', TARGET_PROTECTED: 'لا يمكن معاقبة مالك القروب أو مسؤوليه أو مديري النظام.',
      TARGET_NOT_IN_GROUP: 'يمكن معاقبة أعضاء القروب فقط.', MISSING_MODERATE_MEMBERS: 'البوت لا يملك صلاحية Moderate Members.',
      TARGET_HIERARCHY: 'رتبة العضو أعلى من رتبة البوت أو مساوية لها.'
    };
    await reply(message, messages[error.message] || 'فشلت عملية القروب.');
    return true;
  }
  return true;
}
module.exports = { handleInternalMessage, handleMemberPickerInteraction, leaveGroupMember };
