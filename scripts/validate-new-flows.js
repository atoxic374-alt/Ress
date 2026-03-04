const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function read(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

function checkSyntax(file) {
  const r = spawnSync(process.execPath, ['--check', file], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });
  if (r.status !== 0) {
    throw new Error(`Syntax check failed for ${file}:\n${r.stderr || r.stdout}`);
  }
}

function mustInclude(src, needle, label) {
  assert(src.includes(needle), `Missing expected logic: ${label}`);
}

function run() {
  // 1) Parse/syntax checks for updated handlers
  [
    'bot.js',
    'commands/tops.js',
    'commands/profile.js',
    'commands/check.js',
    'commands/activity-stats.js',
    'commands/admin-apply.js',
    'commands/adminroles.js',
    'commands/roles-settings.js',
    'utils/modifications.js'
  ].forEach(checkSyntax);

  // 2) Stage exclusion + live cap checks across commands
  const tops = read('commands/tops.js');
  mustInclude(tops, 'ChannelType.GuildStageVoice', 'tops: stage exclusion');
  mustInclude(tops, 'const AFK_LIMIT = 24 * 60 * 60 * 1000', 'tops: live cap const');

  const profile = read('commands/profile.js');
  mustInclude(profile, 'const AFK_LIMIT = 24 * 60 * 60 * 1000', 'profile: live cap const');
  mustInclude(profile, 'STAGE_CHANNEL_TYPE = 13', 'profile: stage exclusion');

  const check = read('commands/check.js');
  mustInclude(check, 'ChannelType.GuildStageVoice', 'check: stage exclusion');
  mustInclude(check, 'const AFK_LIMIT = 24 * 60 * 60 * 1000', 'check: live cap const');

  const activity = read('commands/activity-stats.js');
  mustInclude(activity, 'ChannelType.GuildStageVoice', 'activity-stats: stage exclusion');
  mustInclude(activity, 'const AFK_LIMIT = 24 * 60 * 60 * 1000', 'activity-stats: live cap const');

  // 3) Admin apply checks
  const adminApply = read('commands/admin-apply.js');
  mustInclude(adminApply, 'acceptedAdminAnnouncementChannel', 'admin-apply: channel setting persisted');
  mustInclude(adminApply, 'رحبوا بالادمن الجديد', 'admin-apply: welcome embed title');
  mustInclude(adminApply, "content: '@here'", 'admin-apply: here mention');
  mustInclude(adminApply, 'withContextAvatar', 'admin-apply: context avatar helper use');

  // 4) Adminroles checks
  const adminroles = read('commands/adminroles.js');
  mustInclude(adminroles, 'adminroles_confirm_single_', 'adminroles: single-role confirm path');
  mustInclude(adminroles, 'adminroles_confirm_hierarchy_', 'adminroles: hierarchy confirm path');

  // 5) Custom role request flow checks
  const roleSettings = read('commands/roles-settings.js');
  mustInclude(roleSettings, 'configureRequestAllowedRolesByReaction', 'roles-settings: allowed roles setup flow');
  mustInclude(roleSettings, "setCustomId('role_color')", 'roles-settings: color field in modal');
  mustInclude(roleSettings, "setCustomId('role_max_members')", 'roles-settings: max members field in modal');
  mustInclude(roleSettings, 'رول صاحب الطلب', 'roles-settings: requester role field in request embed');
  mustInclude(roleSettings, 'customroles_member_action_info', 'roles-settings: member panel info button');

  // 6) Accelerator hardening checks
  const modifications = read('utils/modifications.js');
  mustInclude(modifications, 'resolveGuildFromInteraction', 'modifications: guild resolver helper');
  mustInclude(modifications, 'ensureAcceleratorExecutable', 'modifications: executable check helper');
  mustInclude(modifications, 'runAccelerator', 'modifications: spawn wrapper helper');

  console.log('✅ validate-new-flows: all checks passed');
}

run();
