const assert = require('node:assert/strict');
const {
  responsibilitySourcesDiffer,
  responsibilityAuthorizationSourcesDiffer,
  buildDesiredRoleAssignments,
  collectActualRoleMemberIds
} = require('./utils/responsibilityRoleReconciler');

const U1 = '111111111111111111';
const U2 = '222222222222222222';
const U3 = '333333333333333333';
const U4 = '444444444444444444';
const U5 = '555555555555555555';
const U6 = '666666666666666666';

async function main() {
  assert.equal(responsibilitySourcesDiffer({ a: 1, b: 2 }, { b: 2, a: 1 }), false);
  assert.equal(responsibilitySourcesDiffer({ resp: { responsibles: ['u1'] } }, { resp: { responsibles: [] } }), true);
  assert.equal(responsibilityAuthorizationSourcesDiffer(
    { resp: { roles: ['r2', 'r1'], responsibles: [U2, U1], members: ['stale'] } },
    { resp: { roles: ['r1', 'r2'], responsibles: [U1, U2] } }
  ), false);
  assert.equal(responsibilityAuthorizationSourcesDiffer(
    { resp: { roles: ['responsibility-role'], responsibles: [] } },
    { resp: { roles: ['responsibility-role'], responsibles: [U1] } }
  ), true);

  const supervisorRoleMembers = new Map([[U4, { id: U4 }]]);
  const supervisorRole = { members: supervisorRoleMembers };
  const guild = {
    id: 'guild',
    roles: {
      cache: new Map([['supervisor-role', supervisorRole]]),
      fetch: async () => null
    }
  };
  const responsibilities = {
    Help: { roles: ['responsibility-role'], responsibles: [U1] },
    Other: { roleId: 'responsibility-role', responsibles: [U2] }
  };
  const supervisors = {
    Help: { userIds: [U3], roleIds: [] },
    Other: { userIds: [], roleIds: ['supervisor-role'] }
  };
  const desired = await buildDesiredRoleAssignments(
    responsibilities,
    guild,
    (_guildId, name) => supervisors[name] || { userIds: [], roleIds: [] }
  );
  assert.deepEqual(
    [...desired.get('responsibility-role')].sort(),
    [U1, U2, U3, U4].sort()
  );

  const actualRole = {
    id: 'responsibility-role',
    members: new Map([[U1, { id: U1 }]])
  };
  const memberSnapshot = new Map([
    [U1, { id: U1, roles: { cache: new Map([['responsibility-role', {}]]) } }],
    [U5, { id: U5, roles: { cache: new Map([['responsibility-role', {}]]) } }],
    [U6, { id: U6, roles: { cache: new Map() } }]
  ]);
  assert.deepEqual(
    [...collectActualRoleMemberIds(actualRole, memberSnapshot)].sort(),
    [U1, U5].sort()
  );

  console.log('Responsibility role reconciliation tests passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
