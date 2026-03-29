const fs = require('fs');
const path = require('path');

const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');

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

function safeReadResponsibilitiesFile() {
  try {
    if (!fs.existsSync(responsibilitiesPath)) return {};
    const raw = fs.readFileSync(responsibilitiesPath, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeResponsibilitiesMap(parsed);
  } catch {
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
  getResponsibilitiesSnapshot
};
