const {
  getResponsibilityMemberIds,
  getResponsibilityRoleIds
} = require('./responsibilitiesStore');
const { getSupervisors } = require('./responsibilitySupervisors');

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function responsibilitySourcesDiffer(left, right) {
  return stableSerialize(left || {}) !== stableSerialize(right || {});
}

function responsibilityAuthorizationSourcesDiffer(left, right) {
  const project = responsibilities => Object.fromEntries(
    Object.entries(responsibilities || {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, config]) => [name, {
      roleIds: getResponsibilityRoleIds(config).map(String).sort(),
      responsibleIds: getResponsibilityMemberIds(config).map(String).sort()
    }])
  );
  return responsibilitySourcesDiffer(project(left), project(right));
}

async function buildDesiredRoleAssignments(responsibilities, guild, supervisorLookup = getSupervisors) {
  const desiredByRole = new Map();
  const ensureRole = roleId => {
    const id = String(roleId);
    if (!desiredByRole.has(id)) desiredByRole.set(id, new Set());
    return desiredByRole.get(id);
  };

  for (const [responsibilityName, config] of Object.entries(responsibilities || {})) {
    const responsibilityRoleIds = getResponsibilityRoleIds(config);
    if (!responsibilityRoleIds.length) continue;

    const desiredUsers = new Set(getResponsibilityMemberIds(config));
    const supervisors = supervisorLookup(guild.id, responsibilityName) || {};
    for (const userId of supervisors.userIds || []) desiredUsers.add(String(userId));

    for (const supervisorRoleId of supervisors.roleIds || []) {
      const supervisorRole = guild.roles.cache.get(String(supervisorRoleId))
        || await guild.roles.fetch(String(supervisorRoleId)).catch(() => null);
      for (const member of supervisorRole?.members?.values?.() || []) {
        desiredUsers.add(String(member.id));
      }
    }

    for (const responsibilityRoleId of responsibilityRoleIds) {
      const allowed = ensureRole(responsibilityRoleId);
      for (const userId of desiredUsers) allowed.add(String(userId));
    }
  }

  return desiredByRole;
}

function collectActualRoleMemberIds(role, memberSnapshot) {
  const memberIds = new Set();
  for (const member of role?.members?.values?.() || []) memberIds.add(String(member.id));
  for (const member of memberSnapshot?.values?.() || []) {
    if (member?.roles?.cache?.has(role.id)) memberIds.add(String(member.id));
  }
  return memberIds;
}

module.exports = {
  stableSerialize,
  responsibilitySourcesDiffer,
  responsibilityAuthorizationSourcesDiffer,
  buildDesiredRoleAssignments,
  collectActualRoleMemberIds
};
