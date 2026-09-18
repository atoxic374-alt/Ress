const assert = require('node:assert/strict');
const { getOnlineResponsibleMentions } = require('./utils/ticketOnline');

const onlineMember = {
  id: '100000000000000001',
  roles: { cache: new Map([['role-responsibility', true]]) },
  presence: { status: 'online' }
};
const idleMember = {
  id: '100000000000000002',
  roles: { cache: new Map([['role-responsibility', true]]) },
  presence: { status: 'offline' }
};
const presenceCacheOnlyMember = { id: '100000000000000003', roles: { cache: new Map() } };
const guild = {
  members: { cache: new Map([
    [onlineMember.id, onlineMember],
    [idleMember.id, idleMember],
    [presenceCacheOnlyMember.id, presenceCacheOnlyMember]
  ]) },
  presences: { cache: new Map([[presenceCacheOnlyMember.id, { status: 'dnd' }]]) }
};

assert.deepEqual(
  getOnlineResponsibleMentions(guild, ['role-responsibility'], []),
  ['<@100000000000000001>']
);
assert.deepEqual(
  getOnlineResponsibleMentions(guild, [], [presenceCacheOnlyMember.id]),
  ['<@100000000000000003>']
);
assert.deepEqual(
  getOnlineResponsibleMentions(guild, ['role-responsibility'], [presenceCacheOnlyMember.id]),
  ['<@100000000000000003>', '<@100000000000000001>']
);

console.log('ticket online checks passed');
