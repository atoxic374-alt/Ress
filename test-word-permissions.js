const assert = require('node:assert/strict');
const {
  canUseWord,
  getAdminRoles,
  getAllowedRoleIds
} = require('./commands/word');

function memberWithRoles(...ids) {
  return { roles: { cache: new Map(ids.map(id => [String(id), { id: String(id) }])) } };
}

const configuredAdminRoles = getAdminRoles();
assert.ok(Array.isArray(configuredAdminRoles), 'admin roles must be an array');

assert.equal(
  canUseWord(memberWithRoles('role-allowed'), { allowedMode: 'roles', allowedRoleIds: ['role-allowed'] }),
  true,
  'a member with the configured allowed role can use the word'
);
assert.equal(
  canUseWord(memberWithRoles('role-other'), { allowedMode: 'roles', allowedRoleIds: ['role-allowed'] }),
  false,
  'a member without the configured allowed role cannot use the word'
);
assert.equal(
  canUseWord(memberWithRoles(), { allowedMode: 'roles', allowedRoleIds: [] }),
  false,
  'an entry without allowed roles is never open to everyone'
);

if (configuredAdminRoles.length > 0) {
  assert.equal(
    canUseWord(memberWithRoles(configuredAdminRoles[0]), { allowedMode: 'admin', allowedRoleIds: [] }),
    true,
    'admin mode accepts a role from adminRoles.json'
  );
  assert.equal(
    canUseWord(memberWithRoles('not-an-admin-role'), { allowedMode: 'admin', allowedRoleIds: [] }),
    false,
    'admin mode rejects members outside adminRoles.json'
  );
}

assert.deepEqual(getAllowedRoleIds({ allowedRoleIds: ['1', 1, null, ''] }), ['1'], 'allowed role ids are normalized strictly');
console.log('word permission tests passed');
