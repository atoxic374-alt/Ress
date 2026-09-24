const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseManager } = require('./utils/database');
const { createBonusManager, calculateAward, chooseOldestGroup, BONUS_METRICS } = require('./utils/bonusManager');
const { buildBonusTopImage } = require('./utils/bonusTopRenderer');
const bonusCommand = require('./commands/bonus');
const interactionRouter = require('./utils/interactionRouter');
const colorManager = require('./utils/colorManager');
const { EventEmitter } = require('node:events');

async function main() {
  assert.deepEqual(calculateAward(250, 50, 300, 1), { leftover: 0, baseAward: 1, awardedPoints: 1, completed: 1 });
  assert.deepEqual(calculateAward(250, 50, 300, 1, 2), { leftover: 0, baseAward: 1, awardedPoints: 2, completed: 1 });
  assert.equal(calculateAward(650, 0, 300, 1).leftover, 50);

  const selected = chooseOldestGroup([
    { id: 1, role_id: 'role-a', created_at: 10 },
    { id: 2, role_id: 'role-b', created_at: 20 }
  ], ['role-a', 'role-b'], { 'role-a': 500, 'role-b': 100 });
  assert.equal(selected.role_id, 'role-b', 'role with earlier grant timestamp is selected');
  assert.equal(bonusCommand.name, 'bonus');
  assert.deepEqual(bonusCommand.parseBonusCustomId('bonus:select:add-role'), {
    prefix: 'bonus', action: 'select', parts: ['add-role']
  });
  assert.deepEqual(bonusCommand.parseBonusCustomId('bonus:select:add-owner'), {
    prefix: 'bonus', action: 'select', parts: ['add-owner']
  });
  const settingsEmbed = bonusCommand.buildHomeEmbed({ name: 'Test Guild' }, {}, [], {}, false);
  assert.equal(settingsEmbed.data.color, Number.parseInt(colorManager.getColor().replace('#', ''), 16), 'bonus embed uses the shared bot-avatar color');
  assert.deepEqual(bonusCommand.buildHomeRows().map(row => row.components.map(component => component.data.label)), [
    ['المسؤولون', 'نقاط التوب', 'إضافة قروب'],
    ['روم التوب', 'لون الصورة', 'نشر / تحديث'],
    ['إدارة القروبات', 'تصفير', 'دبل بونس', 'تحديث اللوحة']
  ]);
  const fakeClient = new EventEmitter();
  fakeClient.guilds = { cache: new Map() };
  bonusCommand.registerInteractionHandler(fakeClient);
  assert.ok(interactionRouter.handlers.some(handler => handler.name === 'bonus-system'), 'bonus handler registers with the shared router');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ress-bonus-test-'));
  const databasePath = path.join(tempDir, 'bonus-test.sqlite');
  const db = new DatabaseManager(databasePath);
  try {
    await db.initialize();
    const bonus = createBonusManager(db);
    const guildId = 'test-guild';
    const actorId = 'test-admin';
    const userId = 'test-user';
    const groupA = await bonus.addGroup(guildId, 'role-a', 'owner-a', actorId);
    const groupB = await bonus.addGroup(guildId, 'role-b', 'owner-b', actorId);
    await bonus.setRule(guildId, BONUS_METRICS.messages, 300, 1, actorId);
    await bonus.setRule(guildId, BONUS_METRICS.voice, 100 * 60 * 60 * 1000, 1, actorId);

    const oldestGroupId = await bonus.resolveTargetGroup(guildId, userId, ['role-a', 'role-b'], { 'role-a': 200, 'role-b': 100 });
    assert.equal(oldestGroupId, Number(groupB.id));

    let result = await bonus.addActivity({ guildId, userId, metric: BONUS_METRICS.messages, amount: 250,
      eventId: 'message:test-guild:100', roleIds: ['role-a', 'role-b'], roleGrantHistory: { 'role-a': 200, 'role-b': 100 } });
    assert.equal(result.awardedPoints, 0);
    assert.equal(result.leftover, 250);
    const duplicate = await bonus.addActivity({ guildId, userId, metric: BONUS_METRICS.messages, amount: 1,
      eventId: 'message:test-guild:100', roleIds: ['role-a', 'role-b'], roleGrantHistory: { 'role-a': 200, 'role-b': 100 } });
    assert.equal(duplicate.duplicate, true, 'duplicate message event cannot count twice');

    result = await bonus.addActivity({ guildId, userId, metric: BONUS_METRICS.messages, amount: 50,
      eventId: 'message:test-guild:101', roleIds: ['role-a', 'role-b'], roleGrantHistory: { 'role-a': 200, 'role-b': 100 } });
    assert.equal(result.awardedPoints, 1);
    assert.equal(result.assignedGroupId, Number(groupB.id));
    const oldReplay = await bonus.addActivity({ guildId, userId, metric: BONUS_METRICS.messages, amount: 1,
      eventId: 'message:test-guild:100', roleIds: ['role-a', 'role-b'], roleGrantHistory: { 'role-a': 200, 'role-b': 100 } });
    assert.equal(oldReplay.duplicate, true, 'an older message arriving late cannot replay a point');

    result = await bonus.addActivity({ guildId, userId, metric: BONUS_METRICS.voice, amount: 50 * 60 * 60 * 1000,
      eventId: 'voice:test-guild:test-user:1:2', roleIds: ['role-a', 'role-b'], roleGrantHistory: { 'role-a': 200, 'role-b': 100 },
      voiceSession: { channelId: 'test-voice-channel', lastCheckpointAt: 2 } });
    assert.equal(result.awardedPoints, 0);
    assert.equal(result.leftover, 50 * 60 * 60 * 1000);
    const savedVoiceCursor = await db.get('SELECT last_checkpoint_at FROM bonus_voice_sessions WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    assert.equal(Number(savedVoiceCursor.last_checkpoint_at), 2, 'voice checkpoint persists atomically with recorded activity');
    const duplicateVoice = await bonus.addActivity({ guildId, userId, metric: BONUS_METRICS.voice, amount: 50 * 60 * 60 * 1000,
      eventId: 'voice:test-guild:test-user:1:2', roleIds: ['role-a', 'role-b'], roleGrantHistory: { 'role-a': 200, 'role-b': 100 } });
    assert.equal(duplicateVoice.duplicate, true, 'voice checkpoint retry cannot double-count');

    await bonus.syncAssignment(guildId, userId, Number(groupA.id), actorId, 'test-transfer');
    let balance = await bonus.getBalance(guildId, userId);
    assert.equal(Number(balance.group_id), Number(groupA.id));
    assert.equal(Number(balance.points), 1, 'points travel with the member');
    assert.equal(Number(balance.message_progress), 0);
    assert.equal(Number(balance.voice_progress_ms), 50 * 60 * 60 * 1000, 'partial voice progress travels with the member');
    let leaderboard = await bonus.getLeaderboard(guildId, 10);
    const pointsA = Number(leaderboard.find(row => Number(row.id) === Number(groupA.id)).points);
    const pointsB = Number(leaderboard.find(row => Number(row.id) === Number(groupB.id)).points);
    assert.equal(pointsA, 1);
    assert.equal(pointsB, 0, 'old group has no duplicate balance');

    await bonus.setMultiplier(guildId, { scope: 'group', groupId: Number(groupA.id) }, actorId);
    await bonus.setMultiplier(guildId, { scope: 'user', groupId: Number(groupA.id), userId }, actorId);
    result = await bonus.addActivity({ guildId, userId, metric: BONUS_METRICS.messages, amount: 300,
      eventId: 'message:test-guild:102', roleIds: ['role-a'], roleGrantHistory: { 'role-a': 200 } });
    assert.equal(result.awardedPoints, 2, 'group and member doubles cap at x2 rather than x4');

    result = await bonus.addActivity({ guildId, userId, metric: BONUS_METRICS.voice, amount: 50 * 60 * 60 * 1000,
      eventId: 'voice:test-guild:test-user:2:3', roleIds: ['role-a'], roleGrantHistory: { 'role-a': 200 } });
    assert.equal(result.awardedPoints, 2, 'double multiplies a completed voice rule');

    const reset = await bonus.resetUser(guildId, Number(groupA.id), userId, actorId);
    assert.ok(reset.points > 0);
    balance = await bonus.getBalance(guildId, userId);
    assert.equal(Number(balance.points), 0);
    assert.equal(Number(balance.message_progress), 0);
    assert.equal(Number(balance.voice_progress_ms), 0);
    await bonus.syncAssignment(guildId, userId, Number(groupB.id), actorId, 'post-reset-transfer');
    balance = await bonus.getBalance(guildId, userId);
    assert.equal(Number(balance.points), 0, 'a transfer after a reset cannot resurrect cleared points');
    await bonus.archiveGroup(guildId, Number(groupB.id), actorId);
    balance = await bonus.getBalance(guildId, userId);
    assert.equal(balance.group_id, null, 'archiving a group unassigns but preserves member balance');
    const restoredGroup = await bonus.addGroup(guildId, 'role-b', 'new-owner-b', actorId);
    assert.equal(Number(restoredGroup.id), Number(groupB.id), 'an archived role can be reactivated without losing history');

    await assert.rejects(db.transaction(async tx => {
      await tx.run('INSERT INTO bonus_audit_log (guild_id, action, details_json, created_at) VALUES (?, ?, ?, ?)',
        [guildId, 'rollback-test', '{}', Date.now()]);
      throw new Error('expected rollback');
    }));
    const rollbackCount = await db.get('SELECT COUNT(*) AS count FROM bonus_audit_log WHERE action = ?', ['rollback-test']);
    assert.equal(Number(rollbackCount.count), 0, 'transaction rolls back partial writes');

    const fakeGuild = {
      name: 'Test Server',
      iconURL: () => null,
      roles: { cache: new Map([['role-a', { name: 'Alpha' }]]) },
      members: { cache: new Map() }
    };
    const rendered = await buildBonusTopImage({
      guild: fakeGuild,
      groups: [{ id: Number(groupA.id), role_id: 'role-a', role_name: 'Alpha', owner_name: 'Owner', points: 3, avatar_url: null }],
      config: { autoColor: true }
    });
    assert.ok(Buffer.isBuffer(rendered.attachment) && rendered.attachment.length > 10000, 'renderer returns a non-empty PNG attachment');
    if (process.env.BONUS_TEST_RENDER_PATH) fs.writeFileSync(process.env.BONUS_TEST_RENDER_PATH, rendered.attachment);

    console.log('✅ bonus system tests passed');
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
