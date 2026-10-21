const gm = require('./groupManager');
const { renderMembers, renderInfo } = require('./groupRenderer');
const { PermissionsBitField } = require('discord.js');

const COMMANDS = new Set(['تحكم', 'control', 'تعديل', 'edit', 'عقوبه', 'عقوبة', 'punish', 'صلاحية', 'permission', 'مسح', 'clear', 'اعضاء', 'أعضاء', 'members', 'اضافة', 'إضافة', 'add', 'ازالة', 'إزالة', 'remove', 'منع', 'block', 'سماح', 'allow', 'قروبي', 'my-group', 'مسؤول', 'manager']);

function ids(message) {
  return [...new Set([...message.mentions.users.keys(), ...(String(message.content).match(/\b\d{16,20}\b/g) || [])])];
}
function groupHasUser(group, userId) {
  const id = String(userId);
  return String(group.owner_id) === id || group.memberIds.includes(id) || group.managerIds.includes(id);
}
async function syncMember(group, guild, userId, add) {
  const member = await guild.members.fetch(String(userId)).catch(() => null);
  if (!member) throw new Error('MEMBER_NOT_FOUND');
  let role = null;
  if (group.role_id) {
    role = guild.roles.cache.get(group.role_id) || await guild.roles.fetch(group.role_id).catch(() => null);
    if (!role) throw new Error('GROUP_ROLE_NOT_FOUND');
  }
  let thread = null;
  if (group.thread_id) {
    thread = guild.channels.cache.get(group.thread_id) || await guild.channels.fetch(group.thread_id).catch(() => null);
    if (!thread?.isThread?.() || !thread.members) throw new Error('GROUP_THREAD_NOT_FOUND');
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
function reply(message, content) { return message.reply(content).catch(() => null); }
async function restoreMembership(group, guildId, userId, wasManager, actorId) {
  await gm.addMember(guildId, group.id, userId, actorId);
  if (wasManager) await gm.setManagers(guildId, group.id, [...group.managerIds, String(userId)], actorId);
}
async function syncManagerRole(guild, settings, userId) {
  if (!settings.managerRoleId) return;
  const member = await guild.members.fetch(String(userId)).catch(() => null);
  if (!member) throw new Error('MEMBER_NOT_FOUND');
  const role = guild.roles.cache.get(settings.managerRoleId) || await guild.roles.fetch(settings.managerRoleId).catch(() => null);
  if (!role) throw new Error('MANAGER_ROLE_NOT_FOUND');
  const groups = await gm.listGroups(guild.id);
  const shouldHaveRole = groups.some(group => group.managerIds.includes(String(userId)));
  const hasRole = member.roles.cache.has(role.id);
  if (shouldHaveRole && !hasRole) await member.roles.add(role, 'Group manager role');
  else if (!shouldHaveRole && hasRole) await member.roles.remove(role, 'Group manager role');
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
  const group = await gm.getGroupForChannel(message.guild.id, message.channel.id);
  if (!group || group.status !== 'active') {
    if (hasPrefix) { await reply(message, 'هذا الشات غير مرتبط بقروب نشط.'); return true; }
    return false;
  }
  const settings = await gm.getSettings(message.guild.id);
  const privileged = gm.canManageGroup(message.client, settings, group, message.member);
  const system = gm.canManageSystem(message.client, settings, message.member);
  const targetId = ids(message)[0];
  try {
    if (command === 'قروبي' || command === 'my-group') {
      if (!groupHasUser(group, message.author.id) && !system) return Boolean(await reply(message, 'أنت لست عضوًا في القروب.'));
      const owner = await message.guild.members.fetch(group.owner_id).catch(() => null);
      const managers = await Promise.all(group.managerIds.map(id => message.guild.members.fetch(id).catch(() => null)));
      await message.reply({ files: [await renderInfo({ guild: message.guild, group, owner, managers: managers.filter(Boolean), accentColor: null })] }).catch(() => {});
      return true;
    }
    if (command === 'اعضاء' || command === 'أعضاء' || command === 'members') {
      const rows = await gm.listMemberPoints(message.guild.id, group.id, 10);
      const members = await Promise.all(rows.map(async row => ({ ...row, member: await message.guild.members.fetch(row.user_id).catch(() => null) })));
      await message.reply({ files: [await renderMembers({ guild: message.guild, group, members, accentColor: null })] }).catch(() => {});
      return true;
    }
    if (!privileged && !system) { await reply(message, 'لا تملك الصلاحية.'); return true; }
    if (command === 'اضافة' || command === 'إضافة' || command === 'add') {
      if (!targetId) throw new Error('MENTION_REQUIRED');
      const target = await message.guild.members.fetch(targetId).catch(() => null);
      if (!target) throw new Error('MEMBER_NOT_FOUND');
      if (target.user?.bot) throw new Error('BOT_NOT_ALLOWED');
      const wasMember = groupHasUser(group, targetId);
      await gm.addMember(message.guild.id, group.id, targetId, message.author.id);
      try { await syncMember(group, message.guild, targetId, true); }
      catch (error) { if (!wasMember) await gm.removeMember(message.guild.id, group.id, targetId, message.author.id).catch(() => { error.groupRollbackFailed = true; }); throw error; }
      await gm.logGroupEvent(message.guild, 'member_add', { groupId: group.id, userId: targetId }, message.author.id);
      await reply(message, 'تمت إضافة العضو.'); return true;
    }
    if (command === 'ازالة' || command === 'إزالة' || command === 'remove') {
      if (!targetId) throw new Error('MENTION_REQUIRED');
      if (String(group.owner_id) === String(targetId)) throw new Error('OWNER_PROTECTED');
      const wasManager = group.managerIds.includes(String(targetId));
      const wasMember = groupHasUser(group, targetId);
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
      await gm.setBlocked(message.guild.id, group.id, targetId, false, message.author.id);
      await gm.logGroupEvent(message.guild, 'unblock', { groupId: group.id, userId: targetId }, message.author.id);
      await reply(message, 'تم السماح للعضو.'); return true;
    }
    if (command === 'مسؤول' || command === 'manager') {
      if (!targetId) throw new Error('MENTION_REQUIRED');
      if (String(group.owner_id) !== String(message.author.id) && !system) throw new Error('OWNER_ONLY');
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
      MANAGER_MUST_BE_MEMBER: 'يجب أن يكون المسؤول عضوًا في القروب.', EXTRA_DISABLED: 'الصلاحيات الإضافية متوقفة.',
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
module.exports = { handleInternalMessage };
