const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');

const dataDir = path.join(__dirname, '..', 'data');
const rolesPath = path.join(dataDir, 'specialRoles.json');
const configPath = path.join(dataDir, 'specialRolesConfig.json');

const DEFAULT_ROLES_DATA = {
  roles: {},
  deleted: {}
};

const DEFAULT_CONFIG_DATA = {};

const cache = {
  roles: null,
  config: null,
  rolesDirty: false,
  configDirty: false,
  rolesSaveTimeout: null,
  configSaveTimeout: null
};

function ensureFile(filePath, defaultData) {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
    }
  } catch (error) {
    console.error(`❌ خطأ في تهيئة الملف ${filePath}:`, error);
  }
}

function loadJson(filePath, defaultData) {
  try {
    ensureFile(filePath, defaultData);
    const data = fs.readFileSync(filePath, 'utf8');
    if (!data || data.trim() === '') return JSON.parse(JSON.stringify(defaultData));
    return JSON.parse(data);
  } catch (error) {
    console.error(`❌ خطأ في قراءة ${filePath}:`, error);
    try {
      if (fs.existsSync(filePath)) {
        const backupPath = `${filePath}.bak.${Date.now()}`;
        fs.copyFileSync(filePath, backupPath);
        console.warn(`⚠️ تم إنشاء نسخة احتياطية للملف التالف: ${backupPath}`);
      }
    } catch (backupError) {
      console.error(`❌ فشل إنشاء نسخة احتياطية لـ ${filePath}:`, backupError);
    }
    return JSON.parse(JSON.stringify(defaultData));
  }
}

function scheduleRolesSave() {
  cache.rolesDirty = true;
  if (cache.rolesSaveTimeout) clearTimeout(cache.rolesSaveTimeout);
  cache.rolesSaveTimeout = setTimeout(() => {
    try {
      fs.writeFileSync(rolesPath, JSON.stringify(cache.roles || DEFAULT_ROLES_DATA, null, 2));
      cache.rolesDirty = false;
    } catch (error) {
      console.error('❌ خطأ في حفظ بيانات الرولات الخاصة:', error);
    }
  }, 1500);
}

function scheduleConfigSave() {
  cache.configDirty = true;
  if (cache.configSaveTimeout) clearTimeout(cache.configSaveTimeout);
  cache.configSaveTimeout = setTimeout(() => {
    try {
      fs.writeFileSync(configPath, JSON.stringify(cache.config || DEFAULT_CONFIG_DATA, null, 2));
      cache.configDirty = false;
    } catch (error) {
      console.error('❌ خطأ في حفظ إعدادات الرولات الخاصة:', error);
    }
  }, 1500);
}

function getRolesData() {
  if (!cache.roles) {
    cache.roles = loadJson(rolesPath, DEFAULT_ROLES_DATA);
    if (!cache.roles.roles) cache.roles.roles = {};
    if (!cache.roles.deleted) cache.roles.deleted = {};
  }
  return cache.roles;
}

function getConfigData() {
  if (!cache.config) {
    cache.config = loadJson(configPath, DEFAULT_CONFIG_DATA);
  }
  return cache.config;
}

function getGuildConfig(guildId) {
  const config = getConfigData();
  if (!config[guildId]) {
    config[guildId] = {
      managerRoleIds: [],
      managerUserIds: [],
      logChannelId: null,
      requestsChannelId: null,
      requestInboxChannelId: null,
      adminControlChannelId: null,
      memberControlChannelId: null,
      requestImage: null,
      adminImage: null,
      memberImage: null,
      topChannelId: null,
      topImage: null,
      topMessageId: null,
      topEnabled: false,
      activityResetAt: null,
      roleCategoryId: null,
      roleIconBackups: {}
    };
    scheduleConfigSave();
  }
  return config[guildId];
}

function updateGuildConfig(guildId, patch) {
  const config = getGuildConfig(guildId);
  Object.assign(config, patch);
  scheduleConfigSave();
  return config;
}

function addRoleEntry(roleId, entry) {
  const data = getRolesData();
  data.roles[roleId] = entry;
  scheduleRolesSave();
  return data.roles[roleId];
}

function deleteRoleEntry(roleId, deletedBy) {
  const data = getRolesData();
  const entry = data.roles[roleId];
  if (!entry) return null;

  if (entry.guildId && entry.ownerId) {
    for (const [deletedRoleId, deletedEntry] of Object.entries(data.deleted)) {
      if (deletedRoleId === roleId) continue;
      if (deletedEntry.guildId === entry.guildId && deletedEntry.ownerId === entry.ownerId) {
        delete data.deleted[deletedRoleId];
      }
    }
  }

  const deletedEntry = {
    ...entry,
    deletedAt: Date.now(),
    deletedBy
  };
  data.deleted[roleId] = deletedEntry;
  delete data.roles[roleId];
  scheduleRolesSave();
  return deletedEntry;
}

function restoreRoleEntry(roleId) {
  const data = getRolesData();
  const entry = data.deleted[roleId];
  if (!entry) return null;
  const restored = {
    ...entry
  };
  delete restored.deletedAt;
  delete restored.deletedBy;
  data.roles[roleId] = restored;
  delete data.deleted[roleId];
  scheduleRolesSave();
  return restored;
}

function findRoleByOwner(guildId, ownerId) {
  const data = getRolesData();
  return Object.values(data.roles).find(role => role.guildId === guildId && role.ownerId === ownerId) || null;
}

function getGuildRoles(guildId) {
  const data = getRolesData();
  return Object.values(data.roles).filter(role => role.guildId === guildId);
}

function getRoleEntry(roleId) {
  const data = getRolesData();
  return data.roles[roleId] || null;
}

function getDeletedRoles(guildId) {
  const data = getRolesData();
  return Object.values(data.deleted).filter(role => role.guildId === guildId);
}

function getDeletedRoleEntry(roleId) {
  const data = getRolesData();
  return data.deleted[roleId] || null;
}

function removeDeletedRoleEntry(roleId) {
  const data = getRolesData();
  const entry = data.deleted[roleId];
  if (!entry) return null;
  delete data.deleted[roleId];
  scheduleRolesSave();
  return entry;
}

function isManager(member, config, botOwners = []) {
  if (!member) return false;
  if (botOwners.includes(member.id)) return true;
  if (member.guild.ownerId === member.id) return true;

  if (config.managerUserIds && config.managerUserIds.includes(member.id)) return true;

  if (config.managerRoleIds && config.managerRoleIds.length > 0) {
    return member.roles.cache.some(role => config.managerRoleIds.includes(role.id));
  }
  return false;
}

function isCustomRolesChannelAllowed(guildConfig, channelId) {
  if (!guildConfig || !channelId) return true;
  const allowed = guildConfig.allowedChannels || [];
  const blocked = guildConfig.blockedChannels || [];
  if (allowed.length > 0) {
    return allowed.includes(channelId);
  }
  if (blocked.length > 0) {
    return !blocked.includes(channelId);
  }
  return true;
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0m';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h  ${minutes}m`;
  return `${minutes}m`;
}

function getResetDate(activityResetAt) {
  if (!activityResetAt) return null;
  return moment(activityResetAt).tz('Asia/Riyadh').format('YYYY-MM-DD');
}

function getRoleResetDate(guildConfig, roleId) {
  if (!guildConfig) return null;
  const roleResetAt = guildConfig.roleActivityResetAt?.[roleId] || guildConfig.activityResetAt;
  return getResetDate(roleResetAt);
}

module.exports = {
  getRolesData,
  getConfigData,
  getGuildConfig,
  updateGuildConfig,
  addRoleEntry,
  deleteRoleEntry,
  restoreRoleEntry,
  findRoleByOwner,
  getGuildRoles,
  getRoleEntry,
  getDeletedRoles,
  getDeletedRoleEntry,
  removeDeletedRoleEntry,
  isManager,
  isCustomRolesChannelAllowed,
  formatDuration,
  getResetDate,
  getRoleResetDate,
  rolesPath,
  configPath
};
