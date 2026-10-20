const assert = require('node:assert/strict');
const { DatabaseManager } = require('./utils/database');
const { ChannelType } = require('discord.js');

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

function testSetupValidation() {
  const basePermissions = new Set(['ManageChannels', 'ManageRoles']);
  const textPermissions = new Set(['ViewChannel', 'ManageChannels', 'ManageThreads', 'SendMessages', 'SendMessagesInThreads']);
  const voicePermissions = new Set(['ViewChannel', 'ManageChannels']);
  const category = permissions => ({ type: ChannelType.GuildCategory, permissionsFor: () => ({ has: permission => permissions.has(permission) }) });
  const guild = {
    members: { me: { permissions: { has: permission => basePermissions.has(permission) }, roles: { highest: { position: 20 } } } },
    channels: { cache: new Map([['text-category', category(textPermissions)], ['voice-category', category(voicePermissions)]]) },
    roles: { cache: new Map() }
  };
  const missing = gm.validateConfig(guild, {
    ...gm.GROUP_DEFAULTS,
    chatMode: 'threads',
    textCategoryId: 'text-category',
    voiceCategoryId: 'voice-category',
    extraPermissions: true,
    logChannelId: 'missing-log-channel'
  });
  assert.ok(missing.includes('categoryPermission:textCategoryId:CreatePrivateThreads'), 'setup detects missing private-thread permission');
  assert.ok(missing.includes('permission:ManageMessages'), 'setup detects permissions required by extra moderation tools');
  assert.ok(missing.includes('logChannelId'), 'setup validates configured log channels');
  assert.equal(missing.includes('permission:BOT_MEMBER'), false);
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
  const groupId = await insertGroup({ guildId, name: 'Membership', memberIds: [OWNER], textChannelId: 'membership-channel' });
  await gm.saveSettings(guildId, { maxMembers: 3 }, OWNER);

  assert.deepEqual(await gm.addMember(guildId, groupId, USER_A, OWNER), [OWNER, USER_A]);
  // Adding an existing member is idempotent rather than duplicating the ID.
  assert.deepEqual(await gm.addMember(guildId, groupId, USER_A, OWNER), [OWNER, USER_A]);
  assert.deepEqual(await gm.addMember(guildId, groupId, USER_B, OWNER), [OWNER, USER_A, USER_B]);
  await assert.rejects(
    gm.addMember(guildId, groupId, USER_C, OWNER),
    error => error.message === 'GROUP_FULL',
    'maxMembers rejects a new member once the configured limit is reached'
  );

  const blockedGroupId = await insertGroup({ guildId: 'blocked-guild', name: 'Blocked' });
  assert.deepEqual(await gm.setBlocked('blocked-guild', blockedGroupId, USER_A, true, OWNER), [USER_A]);
  await assert.rejects(gm.setBlocked('blocked-guild', blockedGroupId, OWNER, true, OWNER), error => error.message === 'OWNER_PROTECTED');
  assert.deepEqual(await gm.setBlocked('blocked-guild', blockedGroupId, USER_A, true, OWNER), [USER_A]);
  await assert.rejects(
    gm.addMember('blocked-guild', blockedGroupId, USER_A, OWNER),
    error => error.message === 'USER_BLOCKED',
    'blocked users cannot be added'
  );
  assert.deepEqual(await gm.setBlocked('blocked-guild', blockedGroupId, USER_A, false, OWNER), []);
  assert.deepEqual(await gm.addMember('blocked-guild', blockedGroupId, USER_A, OWNER), [USER_A]);
  await gm.addMember('blocked-guild', blockedGroupId, USER_B, OWNER);
  await gm.setManagers('blocked-guild', blockedGroupId, [USER_B], OWNER);
  await gm.setBlocked('blocked-guild', blockedGroupId, USER_B, true, OWNER);
  const blockedManagerGroup = await gm.getGroup('blocked-guild', blockedGroupId);
  assert.equal(blockedManagerGroup.memberIds.includes(USER_B), false);
  assert.equal(blockedManagerGroup.managerIds.includes(USER_B), false, 'blocking a manager also removes manager status');
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

  await gm.removeMember(guildId, groupId, USER_A, OWNER);
  assert.deepEqual(await gm.listMemberPoints(guildId, groupId), [], 'former members are not shown in the current member leaderboard');
  await gm.addMember(guildId, groupId, USER_A, OWNER);
  memberPoints = await gm.listMemberPoints(guildId, groupId);
  assert.equal(Number(memberPoints[0].points), 6, 'rejoining restores the retained historical point total');

  // Reset one group and verify both aggregate and per-member points are cleared.
  await gm.resetPoints(guildId, groupId, OWNER);
  group = await gm.getGroup(guildId, groupId);
  memberPoints = await gm.listMemberPoints(guildId, groupId);
  assert.equal(group.points, 0);
  assert.equal(Number(memberPoints[0].points), 0);
  assert.equal(Number(memberPoints[0].messages), 0);

  // Exercise the all-active-groups reset branch as well.
  const secondGroupId = await insertGroup({ guildId, name: 'Points Two', memberIds: [USER_B], points: 8 });
  await testDb.run(
    'INSERT INTO group_member_points(guild_id, group_id, user_id, points, messages, updated_at) VALUES(?,?,?,?,?,?)',
    [guildId, secondGroupId, USER_B, 8, 12, Date.now()]
  );
  await gm.resetPoints(guildId, null, OWNER);
  assert.equal((await gm.getGroup(guildId, secondGroupId)).points, 0);
  const resetRows = await gm.listMemberPoints(guildId, secondGroupId);
  assert.equal(Number(resetRows[0].points), 0);
  assert.equal(Number(resetRows[0].messages), 0);

  const retryGuildId = 'event-retry-guild';
  await insertGroup({ guildId: retryGuildId, name: 'Event retry', memberIds: [USER_C], textChannelId: 'retry-channel' });
  await gm.saveSettings(retryGuildId, { enabled: true }, OWNER);
  await gm.setRule(retryGuildId, 'messages', 1, 1, true, OWNER);
  assert.equal(await gm.recordActivity(retryGuildId, USER_C, 'messages', 1, { channelId: 'unrelated-channel', eventId: 'retry-event' }), 0);
  assert.equal(await gm.recordActivity(retryGuildId, USER_C, 'messages', 1, { channelId: 'retry-channel', eventId: 'retry-event' }), 1,
    'an event rejected for channel scope is not marked as consumed');
  assert.equal(await gm.recordActivity(retryGuildId, USER_C, 'messages', 1, { channelId: 'retry-channel', eventId: 'retry-event' }), 0,
    'an accepted event is still deduplicated');

  const manyMembers = Array.from({ length: 30 }, (_, index) => String(100000000000000100n + BigInt(index)));
  const largeGroupId = await insertGroup({ guildId: retryGuildId, name: 'Large leaderboard', memberIds: manyMembers });
  for (let index = 0; index < manyMembers.length; index += 1) {
    await testDb.run('INSERT INTO group_member_points(guild_id, group_id, user_id, points, updated_at) VALUES(?,?,?,?,?)',
      [retryGuildId, largeGroupId, manyMembers[index], manyMembers.length - index, Date.now()]);
  }
  assert.equal((await gm.listMemberPoints(retryGuildId, largeGroupId, 1000)).length, 30,
    'the all-members leaderboard can return ranks beyond the first 25');
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

  const anotherGroupId = await insertGroup({ guildId, name: 'Other group', ownerId: USER_B, memberIds: [USER_B] });
  await assert.rejects(gm.addMember(guildId, groupId, USER_B, OWNER), error => error.message === 'USER_ALREADY_IN_GROUP');
  assert.equal((await gm.getGroup(guildId, anotherGroupId)).owner_id, USER_B);

  const addManager = parserMessage(guild, `:مسؤول ${USER_A}`);
  await handleInternalMessage(addManager.message);
  assert.deepEqual((await gm.getGroup(guildId, groupId)).managerIds, [USER_A]);
  const removeManagerArabic = parserMessage(guild, `:مسؤول إزالة ${USER_A}`);
  await handleInternalMessage(removeManagerArabic.message);
  assert.deepEqual((await gm.getGroup(guildId, groupId)).managerIds, [], 'Arabic manager removal must remove rather than add');

  const punishWhileDisabled = parserMessage(guild, `:عقوبة ${USER_A}`);
  await handleInternalMessage(punishWhileDisabled.message);
  assert.equal(punishWhileDisabled.replies[0], 'الصلاحيات الإضافية متوقفة.');

  await insertGroup({ guildId, name: 'Ambiguous channel', ownerId: USER_C, memberIds: [USER_C], textChannelId: 'parser-channel' });
  assert.equal(await gm.getGroupForChannel(guildId, 'parser-channel'), null, 'shared channel links are rejected rather than routing to the first group');
}

async function testPartialDeleteCanBeRetried() {
  const guildId = 'delete-retry-guild';
  const groupId = await insertGroup({ guildId, name: 'Delete retry', textChannelId: 'deleted-channel-id' });
  const guild = {
    id: guildId,
    channels: { cache: new Map(), fetch: async () => { const error = new Error('temporary fetch failure'); error.code = 500; throw error; } },
    roles: { cache: new Map() }
  };
  await assert.rejects(gm.deleteGroup(guild, groupId, OWNER), error => error.message === 'GROUP_DELETE_PARTIAL');
  assert.equal((await gm.getGroup(guildId, groupId)).status, 'orphaned', 'partial delete keeps a retryable record');
  guild.channels.fetch = async () => { const error = new Error('unknown channel'); error.code = 10003; throw error; };
  assert.equal(await gm.deleteGroup(guild, groupId, OWNER), true);
  assert.equal((await gm.getGroup(guildId, groupId)).status, 'deleted', 'retry treats a confirmed missing resource as already cleaned');
}

async function main() {
  await testDb.initialize();
  try {
    testSetupValidation();
    await testMembershipLimitsAndBlockedUsers();
    await testPointsAndReset();
    await testInternalCommandParser();
    await testPartialDeleteCanBeRetried();
    console.log('groupManager/groupInternal smoke-integration tests passed');
  } finally {
    await testDb.closeAsync();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
