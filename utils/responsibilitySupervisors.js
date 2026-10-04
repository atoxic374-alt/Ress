const fs = require('fs');
const path = require('path');
const { getDataDir } = require('./storagePaths');

const supervisorsPath = path.join(getDataDir(), 'responsibilitySupervisors.json');

function readStore() {
  try {
    if (!fs.existsSync(supervisorsPath)) return { guilds: {} };
    const parsed = JSON.parse(fs.readFileSync(supervisorsPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? { guilds: {}, ...parsed } : { guilds: {} };
  } catch (error) {
    console.error('خطأ في قراءة ملف مشرفي المسؤوليات:', error);
    return { guilds: {} };
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(supervisorsPath), { recursive: true });
  const tempPath = `${supervisorsPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(store, null, 2));
  fs.renameSync(tempPath, supervisorsPath);
}

function normalizeIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(id => /^\d{16,20}$/.test(id)))];
}

function getGuildData(guildId, store = readStore()) {
  if (!store.guilds[guildId] || typeof store.guilds[guildId] !== 'object') store.guilds[guildId] = {};
  if (!store.guilds[guildId].responsibilities || typeof store.guilds[guildId].responsibilities !== 'object') {
    store.guilds[guildId].responsibilities = {};
  }
  return store.guilds[guildId];
}

function getSupervisors(guildId, responsibilityName) {
  const data = getGuildData(guildId);
  const entry = data.responsibilities[responsibilityName] || {};
  return {
    userIds: normalizeIds(entry.userIds),
    roleIds: normalizeIds(entry.roleIds)
  };
}

function setSupervisors(guildId, responsibilityName, updates = {}) {
  const store = readStore();
  const data = getGuildData(guildId, store);
  const current = getSupervisors(guildId, responsibilityName);
  const userIds = updates.userIds === undefined ? current.userIds : normalizeIds(updates.userIds);
  const roleIds = updates.roleIds === undefined ? current.roleIds : normalizeIds(updates.roleIds);
  if (!userIds.length && !roleIds.length) delete data.responsibilities[responsibilityName];
  else data.responsibilities[responsibilityName] = { userIds, roleIds };
  writeStore(store);
  return { userIds, roleIds };
}

function isSupervisorForResponsibility(guildId, responsibilityName, memberOrUser) {
  const id = String(memberOrUser?.id || memberOrUser?.user?.id || '');
  if (!id) return false;
  const supervisors = getSupervisors(guildId, responsibilityName);
  if (supervisors.userIds.includes(id)) return true;
  const roleIds = memberOrUser?.roles?.cache ? [...memberOrUser.roles.cache.keys()].map(String) : [];
  return supervisors.roleIds.some(roleId => roleIds.includes(roleId));
}

function getSupervisedResponsibilities(guildId, memberOrUser, responsibilities = {}) {
  return Object.keys(responsibilities).filter(name => isSupervisorForResponsibility(guildId, name, memberOrUser));
}

function clearGuildSupervisors(guildId) {
  const store = readStore();
  if (store.guilds && store.guilds[guildId]) {
    delete store.guilds[guildId];
    writeStore(store);
  }
  return true;
}

module.exports = {
  supervisorsPath,
  getSupervisors,
  setSupervisors,
  clearGuildSupervisors,
  isSupervisorForResponsibility,
  getSupervisedResponsibilities
};
