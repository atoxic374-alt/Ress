const fs = require('fs');
const path = require('path');
const { getDataDir } = require('./storagePaths');

const responsibilitiesPath = path.join(getDataDir(), 'responsibilities.json');

function normalizeResponsiblesList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id)))];
}

function normalizeResponsibilitiesMap(responsibilities) {
  if (!responsibilities || typeof responsibilities !== 'object') return {};
  const normalized = {};
  for (const [name, data] of Object.entries(responsibilities)) {
    if (!data || typeof data !== 'object') continue;
    normalized[name] = {
      ...data,
      responsibles: normalizeResponsiblesList(data.responsibles)
    };
  }
  return normalized;
}

function getResponsibilityMemberIds(config) {
  return normalizeResponsiblesList(config?.responsibles);
}

function getResponsibilityRoleIds(config) {
  const roleIds = [];
  if (config?.roleId) roleIds.push(String(config.roleId));
  if (Array.isArray(config?.roles)) {
    for (const roleId of config.roles) {
      if (roleId && !roleIds.includes(String(roleId))) roleIds.push(String(roleId));
    }
  }
  return roleIds;
}

function safeReadResponsibilitiesFile() {
  try {
    if (!fs.existsSync(responsibilitiesPath)) return {};
    const raw = fs.readFileSync(responsibilitiesPath, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeResponsibilitiesMap(parsed);
  } catch (error) {
    console.error(
      `[responsibilitiesStore] Failed to read valid JSON from ${responsibilitiesPath}:`,
      error.message
    );
    return {};
  }
}

function getResponsibilitiesSnapshot() {
  const fromFile = safeReadResponsibilitiesFile();
  if (Object.keys(fromFile).length > 0) {
    global.responsibilities = fromFile;
    return fromFile;
  }

  const fromGlobal = normalizeResponsibilitiesMap(global.responsibilities || {});
  global.responsibilities = fromGlobal;
  return fromGlobal;
}

module.exports = {
  responsibilitiesPath,
  normalizeResponsiblesList,
  normalizeResponsibilitiesMap,
  getResponsibilityMemberIds,
  getResponsibilityRoleIds,
  getResponsibilitiesSnapshot
};
