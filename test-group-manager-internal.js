const assert = require('node:assert/strict');
const { DatabaseManager } = require('./utils/database');

// Keep this integration test isolated from the production SQLite file.
const databaseModule = require('./utils/database');
const testDb = new DatabaseManager(':memory:');
databaseModule.dbManager = testDb;

const gm = require('./utils/groupManager');
const { handleInternalMessage } = require('./utils/groupInternal');

const GUILD = 'group-test-guild';
const OWNER = '100000000000000001';
const USER_A = '100000000000000002';
const USER_B = '100000000000000003';
const USER_C = '100000000000000004';
const ACTOR = '100000000000000005';
const CHANNEL = 'group-text-channel';

async function insertGroup({
  guildId,
  name,
  ownerId = OWNER,
  memberIds = [],
  blockedIds = [],
  points = 0,
  textChannelId = null
}) {
  await gm.schema();
  const now = Date.now();
  const result = await testDb.run(`
    INSERT INTO managed_groups(
      guild_id, name, description, owner_id, manager_ids_json, member_ids_json,
      blocked_ids_json, role_id, text_channel_id, thread_id, voice_channel_id,
      color, emoji, points, status, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `, [
    guildId,
    name,
    '',
    ownerId,
    '[]',
    JSON.stringify(memberIds),
    JSON.stringify(blockedIds),
    null,
    textChannelId,
    null,
    null,
    '#5865F2',
    null,
    points,
    'active',
    now,
    now
  ]);
  return Number(result.id);
}

function makeParserGuild() {
  const roleCache = { some: () => false };
  const ownerMember = {
    id: OWNER,
    roles: { cache: roleCache, add: async () => {}, remove: async () => {} }
  };
  const targetMember = {
    id: USER_A,
    roles: { cache: roleCache, add: async () => {}, remove: async () => {} }
  };
  const members = new Map([[OWNER, ownerMember], [USER_A, targetMember]]);
  return {
    id: 'parser-guild',
    ownerId: OWNER,
    roles: { cache: new Map() },
    channels: { cache: new Map() },
    members: {
      fetch: async userId => members.get(String(userId)) || null
    }
  };
}

function parserMessage(guild, content) {
  const replies = [];
  const message = {
    guild,
    channel: { id: 'parser-channel' },
    author: { id: OWNER, bot: false },
    member: { id: OWNER, guild: { ownerId: OWNER }, roles: { cache: { some: () => false } } },
    client: {},
    content,
    mentions: { users: new Map() },
    reply: async value => {
      replies.push(value);
      return { delete: async () => {} };
    }
  };
  return { message, replies };
}

async function testMembershipLimitsAndBlockedUsers() {
  const guildId = 'membership-guild';
  const groupId = await insertGroup({ guildId, name: 'Membership', textChannelId: 'membership-channel' });
  await gm.saveSettings(guildId, { maxMembers: 2 }, OWNER);

  assert.deepEqual(await gm.addMember(guildId, groupId, USER_A, OWNER), [USER_A]);
  // Adding an existing member is idempotent rather than duplicating the ID.
  assert.deepEqual(await gm.addMember(guildId, groupId, USER_A, OWNER), [USER_A]);
  assert.deepEqual(await gm.addMember(guildId, groupId, USER_B, OWNER), [USER_A, USER_B]);
  await assert.rejects(
    gm.addMember(guildId, groupId, USER_C, OWNER),
    error => error.message === 'GROUP_FULL',
    'maxMembers rejects a new member once the configured limit is reached'
  );

  const blockedGroupId = await insertGroup({ guildId: 'blocked-guild', name: 'Blocked' });
  assert.deepEqual(await gm.setBlocked('blocked-guild', blockedGroupId, USER_A, true, OWNER), [USER_A]);
  assert.deepEqual(await gm.setBlocked('blocked-guild', blockedGroupId, USER_A, true, OWNER), [USER_A]);
  await assert.rejects(
    gm.addMember('blocked-guild', blockedGroupId, USER_A, OWNER),
    error => error.message === 'USER_BLOCKED',
    'blocked users cannot be added'
  );
  assert.deepEqual(await gm.setBlocked('blocked-guild', blockedGroupId, USER_A, false, OWNER), []);
  assert.deepEqual(await gm.addMember('blocked-guild', blockedGroupId, USER_A, OWNER), [USER_A]);
}

async function testPointsAndReset() {
  const guildId = 'points-guild';
  const groupId = await insertGroup({
    guildId,
    name: 'Points',
    memberIds: [USER_A],
    textChannelId: 'points-channel'
  });
  await gm.saveSettings(guildId, { enabled: true }, OWNER);
  await gm.setRule(guildId, 'messages', 10, 3, true, OWNER);

  assert.equal(await gm.recordActivity(guildId, USER_A, 'messages', 9, { channelId: 'other-channel', eventId: 'points-1' }), 0,
    'group-scoped points ignore unrelated channels');
  assert.equal(await gm.recordActivity(guildId, USER_A, 'messages', 9, { channelId: 'points-channel', eventId: 'points-2' }), 0);
  assert.equal(await gm.recordActivity(guildId, USER_A, 'messages', 1, { channelId: 'points-channel', eventId: 'points-3' }), 3,
    'the threshold awards the configured points');
  assert.equal(await gm.recordActivity(guildId, USER_A, 'messages', 1, { channelId: 'points-channel', eventId: 'points-3' }), 0,
    'replaying the same activity event does not award points twice');
  assert.equal(await gm.recordActivity(guildId, USER_A, 'messages', 10, { channelId: 'points-channel', eventId: 'points-4' }), 3,
    'subsequent complete thresholds award once per threshold');

  let group = await gm.getGroup(guildId, groupId);
  assert.equal(group.points, 6);
  let memberPoints = await gm.listMemberPoints(guildId, groupId);
  assert.equal(Number(memberPoints[0].points), 6);
  assert.equal(Number(memberPoints[0].messages), 20);

  // Reset one group and verify both aggregate and per-member points are cleared.
  await gm.resetPoints(guildId, groupId, OWNER);
  group = await gm.getGroup(guildId, groupId);
  memberPoints = await gm.listMemberPoints(guildId, groupId);
  assert.equal(group.points, 0);
  assert.equal(Number(memberPoints[0].points), 0);
  assert.equal(Number(memberPoints[0].messages), 0);

  // Exercise the all-active-groups reset branch as well.
  const secondGroupId = await insertGroup({ guildId, name: 'Points Two', points: 8 });
  await testDb.run(
    'INSERT INTO group_member_points(guild_id, group_id, user_id, points, messages, updated_at) VALUES(?,?,?,?,?,?)',
    [guildId, secondGroupId, USER_B, 8, 12, Date.now()]
  );
  await gm.resetPoints(guildId, null, OWNER);
  assert.equal((await gm.getGroup(guildId, secondGroupId)).points, 0);
  const resetRows = await gm.listMemberPoints(guildId, secondGroupId);
  assert.equal(Number(resetRows[0].points), 0);
  assert.equal(Number(resetRows[0].messages), 0);
}

async function testInternalCommandParser() {
  const guild = makeParserGuild();
  const guildId = guild.id;
  const groupId = await insertGroup({
    guildId,
    name: 'Parser',
    ownerId: OWNER,
    memberIds: [OWNER],
    textChannelId: 'parser-channel'
  });

  const nonCommand = parserMessage(guild, 'hello there');
  assert.equal(await handleInternalMessage(nonCommand.message), false,
    'messages without the configured prefix are ignored');
  assert.deepEqual(nonCommand.replies, []);

  const englishAdd = parserMessage(guild, `:add ${USER_A}`);
  assert.equal(await handleInternalMessage(englishAdd.message), true);
  assert.deepEqual(englishAdd.replies, ['تمت إضافة العضو.']);
  assert.deepEqual((await gm.getGroup(guildId, groupId)).memberIds, [OWNER, USER_A]);

  // The same parser command is safe to repeat and does not duplicate membership.
  const repeatedAdd = parserMessage(guild, `:add ${USER_A}`);
  await handleInternalMessage(repeatedAdd.message);
  assert.deepEqual((await gm.getGroup(guildId, groupId)).memberIds, [OWNER, USER_A]);

  const arabicBlock = parserMessage(guild, `:منع ${USER_A}`);
  assert.equal(await handleInternalMessage(arabicBlock.message), true);
  let parsedGroup = await gm.getGroup(guildId, groupId);
  assert.deepEqual(parsedGroup.blockedIds, [USER_A]);
  assert.deepEqual(parsedGroup.memberIds, [OWNER]);

  const repeatedBlock = parserMessage(guild, `:block ${USER_A}`);
  await handleInternalMessage(repeatedBlock.message);
  parsedGroup = await gm.getGroup(guildId, groupId);
  assert.deepEqual(parsedGroup.blockedIds, [USER_A], 'repeated block does not duplicate IDs');

  const allow = parserMessage(guild, `:allow ${USER_A}`);
  assert.equal(await handleInternalMessage(allow.message), true);
  const arabicAdd = parserMessage(guild, `:إضافة ${USER_A}`);
  assert.equal(await handleInternalMessage(arabicAdd.message), true);
  assert.deepEqual((await gm.getGroup(guildId, groupId)).memberIds, [OWNER, USER_A]);
}

async function main() {
  await testDb.initialize();
  try {
    await testMembershipLimitsAndBlockedUsers();
    await testPointsAndReset();
    await testInternalCommandParser();
    console.log('groupManager/groupInternal smoke-integration tests passed');
  } finally {
    await testDb.closeAsync();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
