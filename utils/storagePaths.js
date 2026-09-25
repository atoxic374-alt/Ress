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

  // Keep a local recovery copy. If a deploy/startup step removes the main
  // file, restore the last real configuration instead of rebuilding it from
  // OWNER_ID/BOT_OWNERS with only the minimal defaults.
  const recoveryPath = `${targetPath}.bak`;
  let targetConfig = null;
  let recoveryConfig = null;
  try {
    if (fs.existsSync(targetPath)) {
      targetConfig = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    }
  } catch (_) {}
  try {
    if (fs.existsSync(recoveryPath)) {
      recoveryConfig = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
    }
  } catch (_) {}

  const isMinimalEnvConfig = (config) => {
    if (!config || !Array.isArray(config.owners) || config.owners.length !== 1) return false;
    return Object.keys(config).every((key) => ['owners', 'prefix', 'settings', 'activeTasks', 'pendingReports'].includes(key));
  };

  if (!targetConfig && recoveryConfig) {
    fs.copyFileSync(recoveryPath, targetPath);
  } else if (targetConfig && recoveryConfig && isMinimalEnvConfig(targetConfig)
      && Object.keys(recoveryConfig).length > Object.keys(targetConfig).length) {
    fs.copyFileSync(recoveryPath, targetPath);
  } else if (targetConfig) {
    // Refresh the recovery copy only from a valid, non-minimal configuration.
    if (!isMinimalEnvConfig(targetConfig)) {
      fs.copyFileSync(targetPath, recoveryPath);
    }
  }

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
