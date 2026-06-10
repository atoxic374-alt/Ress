const fs = require('fs');
const path = require('path');
const backCommand = require('./back (2).js');
const { getBackupsDir } = require('../utils/storagePaths');

function getAllBackups() {
  const backupsDir = getBackupsDir();
  if (!fs.existsSync(backupsDir)) return [];

  return fs.readdirSync(backupsDir)
    .filter((fileName) => fileName.endsWith('.json'))
    .map((fileName) => {
      const filePath = path.join(backupsDir, fileName);
      try {
        const backup = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return {
          ...backup,
          fileName,
          createdAt: backup.createdAt || fs.statSync(filePath).mtimeMs,
        };
      } catch (error) {
        console.error(`⚠️ تعذر قراءة ملف الباكب ${fileName}:`, error.message);
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

module.exports = {
  getAllBackups,
  registerBackupModalHandler: backCommand.registerInteractionHandler?.bind(backCommand),
};
