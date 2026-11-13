'use strict';

const assert = require('node:assert/strict');
const { getGroupMemberCount } = require('./utils/groupMetrics');

assert.equal(getGroupMemberCount({ memberCount: 12 }), 12, 'uses memberCount when membership lists are absent');
assert.equal(getGroupMemberCount({ member_count: '7' }), 7, 'accepts the snake_case count from external data');
assert.equal(getGroupMemberCount({ owner_id: 'owner', memberIds: ['a', 'b'], managerIds: ['b', 'c'] }), 4,
  'counts unique owner, members, and managers without duplicates');
assert.equal(getGroupMemberCount({ memberIds: [], managerIds: [], memberCount: 12 }), 0,
  'explicit empty membership lists are authoritative over a stale count');
assert.equal(getGroupMemberCount(null, 9), 9, 'uses the rendered row count when there is no group object');
assert.equal(getGroupMemberCount({ memberCount: -5 }), 0, 'does not return a negative member count');

console.log('group renderer member-count checks passed');
