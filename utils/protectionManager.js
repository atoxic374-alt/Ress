const fs = require('fs');
const path = require('path');
const { ChannelType } = require('discord.js');

const dataDir = path.join(__dirname, '..', 'data');
const protectionPath = path.join(dataDir, 'protection.json');
const backupsDir = path.join(__dirname, '..', 'backups');

const activeRestores = new Set();
const restoringStates = new Map();
const pendingChecks = new Map();

function cancelPendingCheck(guildId) {
  if (pendingChecks.has(guildId)) {
    clearTimeout(pendingChecks.get(guildId));
    pendingChecks.delete(guildId);
  }
}

function readJSON(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return fallback;
  }
}

function writeJSON(filePath, data) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function getConfig() {
  return readJSON(protectionPath, {});
}

function setConfig(guildId, config) {
  const all = getConfig();
  all[guildId] = config;
  writeJSON(protectionPath, all);
}

function getGuildConfig(guildId) {
  const all = getConfig();
  return all[guildId] || null;
}

function getCurrentRoleCount(guild) {
  return guild.roles.cache.filter(role => !role.managed && role.id !== guild.id).size;
}

function getCurrentChannelCount(guild) {
  return guild.channels.cache.filter(ch => !ch.isThread()).size;
}

function loadBackupStats(backupFileName) {
  const backupPath = path.join(backupsDir, backupFileName);
  const data = readJSON(backupPath, null);
  if (!data || !data.stats) return null;
  return {
    channels: (data.stats.channels || 0) + (data.stats.categories || 0),
    roles: data.stats.roles || 0
  };
}

async function deleteChannelsOnly(guild) {
  const channels = [...guild.channels.cache.values()].filter(ch => !ch.isThread());
  await Promise.allSettled(
    channels.map(ch => ch.delete('حماية الباكب: تنظيف الرومات قبل الاستعادة').catch(() => {}))
  );
}

async function deleteRolesOnly(guild) {
  const roles = [...guild.roles.cache.values()].filter(role => !role.managed && role.id !== guild.id);
  await Promise.allSettled(
    roles.map(role => role.delete('حماية الباكب: تنظيف الرولات قبل الاستعادة').catch(() => {}))
  );
}

async function restoreProtection(backupFileName, guild, mode) {
  const backupPath = path.join(backupsDir, backupFileName);
  const backupData = readJSON(backupPath, null);
  if (!backupData?.data) return;

  const roleMap = new Map();
  const channelMap = new Map();
  const categoryMap = new Map();

  const convertPermissions = (overwrites) => {
    return overwrites.map(ow => {
      if (ow.id === backupData.guildId || ow.type === 1) {
        return { id: ow.type === 1 ? ow.id : guild.id, allow: BigInt(ow.allow), deny: BigInt(ow.deny) };
      }
      const mappedRoleId = roleMap.get(ow.id) || (guild.roles.cache.has(ow.id) ? ow.id : null);
      if (!mappedRoleId) return null;
      return { id: mappedRoleId, allow: BigInt(ow.allow), deny: BigInt(ow.deny) };
    }).filter(ow => ow !== null);
  };

  if (mode === 'roles' || mode === 'all') {
    const roleResults = await Promise.allSettled(
      (backupData.data.roles || []).map(async (roleData) => {
        try {
          const newRole = await guild.roles.create({
            name: roleData.name,
            color: roleData.color,
            permissions: BigInt(roleData.permissions),
            hoist: roleData.hoist,
            mentionable: roleData.mentionable
          });
          roleMap.set(roleData.id, newRole.id);
          return newRole;
        } catch (err) {
          return null;
        }
      })
    );

    const rolePositions = [];
    (backupData.data.roles || []).forEach(roleData => {
      const newRoleId = roleMap.get(roleData.id);
      if (newRoleId) {
        rolePositions.push({ role: newRoleId, position: roleData.position });
      }
    });
    if (rolePositions.length > 0) {
      await guild.roles.setPositions(rolePositions).catch(() => {});
    }
  }

  if (mode === 'channels' || mode === 'all') {
    const createRootChannels = Promise.allSettled(
      (backupData.data.channels || []).map(async (chData) => {
        try {
          const opts = {
            name: chData.name,
            type: chData.type,
            position: chData.position,
            permissionOverwrites: convertPermissions(chData.permissionOverwrites || [])
          };
          if (chData.topic) opts.topic = chData.topic;
          if (chData.nsfw !== undefined) opts.nsfw = chData.nsfw;
          if (chData.rateLimitPerUser) opts.rateLimitPerUser = chData.rateLimitPerUser;
          if (chData.bitrate) opts.bitrate = chData.bitrate;
          if (chData.userLimit) opts.userLimit = chData.userLimit;
          const newCh = await guild.channels.create(opts);
          channelMap.set(chData.id, newCh.id);
          return newCh;
        } catch (err) {
          return null;
        }
      })
    );

    const createCategoryPipelines = (backupData.data.categories || []).map(async (catData) => {
      try {
        const newCat = await guild.channels.create({
          name: catData.name,
          type: ChannelType.GuildCategory,
          position: catData.position,
          permissionOverwrites: convertPermissions(catData.permissionOverwrites || [])
        });
        categoryMap.set(catData.id, newCat.id);
        channelMap.set(catData.id, newCat.id);

        await Promise.allSettled(
          (catData.channels || []).map(async (chData) => {
            try {
              const opts = {
                name: chData.name,
                type: chData.type,
                parent: newCat.id,
                position: chData.position,
                permissionOverwrites: convertPermissions(chData.permissionOverwrites || [])
              };
              if (chData.topic) opts.topic = chData.topic;
              if (chData.nsfw !== undefined) opts.nsfw = chData.nsfw;
              if (chData.rateLimitPerUser) opts.rateLimitPerUser = chData.rateLimitPerUser;
              if (chData.bitrate) opts.bitrate = chData.bitrate;
              if (chData.userLimit) opts.userLimit = chData.userLimit;
              const newCh = await guild.channels.create(opts);
              channelMap.set(chData.id, newCh.id);
              return newCh;
            } catch (err) {
              return null;
            }
          })
        );

        return newCat;
      } catch (err) {
        return null;
      }
    });

    await Promise.allSettled([createRootChannels, ...createCategoryPipelines]);

    const positions = [];
    for (const catData of backupData.data.categories || []) {
      const newCatId = categoryMap.get(catData.id);
      if (newCatId) {
        positions.push({ channel: newCatId, position: catData.position });
      }
      for (const chData of catData.channels || []) {
        const newChId = channelMap.get(chData.id);
        if (newChId) {
          positions.push({ channel: newChId, position: chData.position });
        }
      }
    }
    for (const chData of backupData.data.channels || []) {
      const newChId = channelMap.get(chData.id);
      if (newChId) {
        positions.push({ channel: newChId, position: chData.position });
      }
    }
    if (positions.length > 0) {
      await guild.channels.setPositions(positions).catch(() => {});
    }
  }
}

async function triggerRestore(guild, config, reason, mode) {
  if (!config?.backupFile || activeRestores.has(guild.id)) return;
  activeRestores.add(guild.id);
  restoringStates.set(guild.id, { startedAt: Date.now(), reason });
  cancelPendingCheck(guild.id);
  try {
    if (mode === 'channels') {
      await deleteChannelsOnly(guild);
    } else if (mode === 'roles') {
      await deleteRolesOnly(guild);
    } else {
      await Promise.allSettled([deleteChannelsOnly(guild), deleteRolesOnly(guild)]);
    }
    await restoreProtection(config.backupFile, guild, mode);
  } catch (error) {
    console.error('❌ خطأ في حماية الباكب:', reason, error);
  } finally {
    activeRestores.delete(guild.id);
    restoringStates.delete(guild.id);
  }
}

function scheduleCheck(guild, config, reason) {
  cancelPendingCheck(guild.id);
  const timeoutId = setTimeout(async () => {
    pendingChecks.delete(guild.id);
    if (activeRestores.has(guild.id) || restoringStates.has(guild.id)) return;
    const channelCount = getCurrentChannelCount(guild);
    const roleCount = getCurrentRoleCount(guild);
    const expectedChannels = config.expectedChannels || 0;
    const expectedRoles = config.expectedRoles || 0;
    const channelTrigger = expectedChannels > 0 && channelCount === 0;
    const roleTrigger = expectedRoles > 0 && roleCount <= Math.floor(expectedRoles / 2);
    if (channelTrigger || roleTrigger) {
      const mode = channelTrigger && roleTrigger ? 'all' : (channelTrigger ? 'channels' : 'roles');
      await triggerRestore(guild, config, reason, mode);
      return;
    }

    const channelsMissing = expectedChannels > 0 && channelCount < expectedChannels;
    const rolesMissing = expectedRoles > 0 && roleCount < expectedRoles;
    if (channelsMissing || rolesMissing) {
      const mode = channelsMissing && rolesMissing ? 'all' : (channelsMissing ? 'channels' : 'roles');
      await triggerRestore(guild, config, 'repair', mode);
    }
  }, 250);
  pendingChecks.set(guild.id, timeoutId);
}

function handleChannelDelete(channel) {
  const guild = channel.guild;
  if (!guild) return;
  const config = getGuildConfig(guild.id);
  if (!config?.enabled) return;
  if (activeRestores.has(guild.id) || restoringStates.has(guild.id)) return;
  scheduleCheck(guild, config, 'channels');
}

function handleRoleDelete(role) {
  const guild = role.guild;
  if (!guild) return;
  const config = getGuildConfig(guild.id);
  if (!config?.enabled) return;
  if (activeRestores.has(guild.id) || restoringStates.has(guild.id)) return;
  scheduleCheck(guild, config, 'roles');
}

function enableProtection(guildId, backupFile, enabledBy) {
  const stats = loadBackupStats(backupFile);
  const config = {
    enabled: true,
    backupFile,
    enabledBy,
    enabledAt: Date.now(),
    expectedChannels: stats?.channels || 0,
    expectedRoles: stats?.roles || 0
  };
  setConfig(guildId, config);
  return config;
}

module.exports = {
  getGuildConfig,
  enableProtection,
  handleChannelDelete,
  handleRoleDelete
};
