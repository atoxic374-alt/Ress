const gm = require('./groupManager');
const { renderMembers, renderInfo } = require('./groupRenderer');

const COMMANDS = new Set(['تحكم', 'control', 'تعديل', 'edit', 'عقوبه', 'عقوبة', 'punish', 'صلاحية', 'permission', 'مسح', 'clear', 'اعضاء', 'أعضاء', 'members', 'اضافة', 'إضافة', 'add', 'ازالة', 'إزالة', 'remove', 'منع', 'block', 'سماح', 'allow', 'قروبي', 'my-group', 'مسؤول', 'manager']);

function ids(message) {
  return [...new Set([...message.mentions.users.keys(), ...(String(message.content).match(/\b\d{16,20}\b/g) || [])])];
}
async function syncMember(group, guild, userId, add) {
  const member = await guild.members.fetch(String(userId)).catch(() => null);
  if (!member) throw new Error('MEMBER_NOT_FOUND');
  const role = group.role_id && guild.roles.cache.get(group.role_id);
  if (role) await (add ? member.roles.add(role, 'Managed group membership') : member.roles.remove(role, 'Managed group membership'));
  const thread = group.thread_id && guild.channels.cache.get(group.thread_id);
  if (thread?.members) await (add ? thread.members.add(member.id) : thread.members.remove(member.id)).catch(() => {});
  return member;
}
function reply(message, content) { return message.reply(content).catch(() => null); }
async function handleInternalMessage(message, { prefix = ':', sendPanel = null } = {}) {
  if (!message?.guild || message.author?.bot || !String(message.content || '').startsWith(prefix)) return false;
  const raw = String(message.content).slice(prefix.length).trim();
  const words = raw.split(/\s+/);
  let command = String(words.shift() || '').toLowerCase();
  if (command === 'تعديل' && String(words[0] || '') === 'القروب') { command = 'تعديل'; words.shift(); }
  if (!COMMANDS.has(command)) return false;
  const group = await gm.getGroupForChannel(message.guild.id, message.channel.id);
  if (!group) { await reply(message, 'هذا الشات غير مرتبط بقروب.'); return true; }
  const settings = await gm.getSettings(message.guild.id);
  const privileged = gm.canManageGroup(message.client, settings, group, message.member);
  const system = gm.canManageSystem(message.client, settings, message.member);
  const targetId = ids(message)[0];
  try {
    if (command === 'قروبي' || command === 'my-group') {
      if (!group.memberIds.includes(String(message.author.id)) && !system) return Boolean(await reply(message, 'أنت لست عضوًا في القروب.'));
      const owner = await message.guild.members.fetch(group.owner_id).catch(() => null);
      const managers = await Promise.all(group.managerIds.map(id => message.guild.members.fetch(id).catch(() => null)));
      await message.reply({ files: [await renderInfo({ guild: message.guild, group, owner, managers: managers.filter(Boolean), accentColor: group.color })] }).catch(() => {});
      return true;
    }
    if (command === 'اعضاء' || command === 'أعضاء' || command === 'members') {
      const rows = await gm.listMemberPoints(message.guild.id, group.id, 10);
      const members = await Promise.all(rows.map(async row => ({ ...row, member: await message.guild.members.fetch(row.user_id).catch(() => null) })));
      await message.reply({ files: [await renderMembers({ guild: message.guild, group, members, accentColor: group.color })] }).catch(() => {});
      return true;
    }
    if (!privileged && !system) { await reply(message, 'لا تملك الصلاحية.'); return true; }
    if (command === 'اضافة' || command === 'إضافة' || command === 'add') {
      if (!targetId) throw new Error('MENTION_REQUIRED');
      await gm.addMember(message.guild.id, group.id, targetId, message.author.id);
      await syncMember(group, message.guild, targetId, true);
      await gm.logGroupEvent(message.guild, 'member_add', { groupId: group.id, userId: targetId }, message.author.id);
      await reply(message, 'تمت إضافة العضو.'); return true;
    }
    if (command === 'ازالة' || command === 'إزالة' || command === 'remove') {
      if (!targetId) throw new Error('MENTION_REQUIRED');
      await gm.removeMember(message.guild.id, group.id, targetId, message.author.id);
      await syncMember(group, message.guild, targetId, false);
      await gm.logGroupEvent(message.guild, 'member_remove', { groupId: group.id, userId: targetId }, message.author.id);
      await reply(message, 'تمت إزالة العضو.'); return true;
    }
    if (command === 'منع' || command === 'block') {
      if (!targetId) throw new Error('MENTION_REQUIRED');
      await gm.setBlocked(message.guild.id, group.id, targetId, true, message.author.id);
      await gm.removeMember(message.guild.id, group.id, targetId, message.author.id).catch(() => {});
      await gm.logGroupEvent(message.guild, 'block', { groupId: group.id, userId: targetId }, message.author.id);
      await syncMember(group, message.guild, targetId, false).catch(() => {});
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
      const managers = new Set(group.managerIds);
      if (/\b(remove|ازالة|إزالة)\b/i.test(raw)) managers.delete(String(targetId));
      else { if (!group.memberIds.includes(String(targetId))) throw new Error('MANAGER_MUST_BE_MEMBER'); managers.add(String(targetId)); }
      await gm.setManagers(message.guild.id, group.id, [...managers], message.author.id);
      await gm.logGroupEvent(message.guild, 'manager_update', { groupId: group.id, managerIds: [...managers] }, message.author.id);
      const managerRole = settings.managerRoleId && message.guild.roles.cache.get(settings.managerRoleId);
      if (managerRole) { const target = await message.guild.members.fetch(targetId).catch(() => null); if (target) await (managers.has(String(targetId)) ? target.roles.add(managerRole, 'Group manager role') : target.roles.remove(managerRole, 'Group manager role')).catch(() => {}); }
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
      if (!targetId) throw new Error('MENTION_REQUIRED');
      const target = await message.guild.members.fetch(targetId);
      await target.timeout(10 * 60 * 1000, 'Group punishment');
      await reply(message, 'تم تطبيق عقوبة 10 دقائق.'); return true;
    }
    if (command === 'صلاحية' || command === 'permission') { await reply(message, 'استخدم رول القروب للتحكم بالوصول.'); return true; }
    if (command === 'تحكم' || command === 'control') { if (typeof sendPanel === 'function') await sendPanel(message.channel, message.guild, group.id); else await reply(message, 'لوحة التحكم غير متاحة.'); return true; }
    if (command === 'تعديل' || command === 'edit') { await reply(message, 'استخدم لوحة التحكم لتعديل القروب.'); return true; }
  } catch (error) {
    const messages = { MENTION_REQUIRED: 'اذكر عضوًا أولًا.', OWNER_ONLY: 'هذه العملية للمالك فقط.', MANAGER_MUST_BE_MEMBER: 'يجب أن يكون المسؤول عضوًا في القروب.', EXTRA_DISABLED: 'الصلاحيات الإضافية متوقفة.', MEMBER_NOT_FOUND: 'العضو غير موجود.' };
    await reply(message, messages[error.message] || 'فشلت عملية القروب.');
    return true;
  }
  return true;
}
module.exports = { handleInternalMessage };
