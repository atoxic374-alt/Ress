const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');

function isRailwayVolumePath(value) {
  return typeof value === 'string' && value.trim() && path.isAbsolute(value.trim());
}

function getRailwayVolumeMountPath() {
  const mountPath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  return isRailwayVolumePath(mountPath) ? mountPath.trim() : null;
}

function resolveStoragePath(...segments) {
  const volumeMountPath = getRailwayVolumeMountPath();
  if (!volumeMountPath) return path.join(projectRoot, ...segments);

  const firstSegment = String(segments[0] || '');

  // If the Railway volume is mounted directly to /app/data or /app/database,
  // do not append the same top-level folder twice.
  if (firstSegment && path.basename(volumeMountPath) === firstSegment) {
    return path.join(volumeMountPath, ...segments.slice(1));
  }

  return path.join(volumeMountPath, ...segments);
}

function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

function ensureParentDirSync(filePath) {
  ensureDirSync(path.dirname(filePath));
  return filePath;
}

function getDatabaseDir() {
  return ensureDirSync(resolveStoragePath('database'));
}

function getDatabasePath(fileName = 'discord_bot.db') {
  return ensureParentDirSync(path.join(getDatabaseDir(), fileName));
}

/**
 * botConfig contains runtime settings and must not live in the tracked project
 * tree. When a persistent volume is configured, getDataDir() resolves to that
 * volume; otherwise this keeps the existing project data file so deployments
 * that preserve the project filesystem do not lose their configuration.
 */
function getBotConfigPath() {
  const configuredPath = process.env.BOT_CONFIG_PATH;
  const targetPath = isRailwayVolumePath(configuredPath)
    ? configuredPath.trim()
    : path.join(resolveStoragePath('data'), 'botConfig.json');
  ensureParentDirSync(targetPath);

  return targetPath;
}

function getDataDir() {
  return ensureDirSync(resolveStoragePath('data'));
}

function getBackupsDir(...segments) {
  return ensureDirSync(resolveStoragePath('backups', ...segments));
}

module.exports = {
  projectRoot,
  getRailwayVolumeMountPath,
  resolveStoragePath,
  ensureDirSync,
  ensureParentDirSync,
  getDatabaseDir,
  getDatabasePath,
  getBotConfigPath,
  getDataDir,
  getBackupsDir,
};
