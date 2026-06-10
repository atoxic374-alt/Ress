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
  getDataDir,
  getBackupsDir,
};
