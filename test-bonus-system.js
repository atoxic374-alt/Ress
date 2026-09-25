const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseManager } = require('./utils/database');
const { createBonusManager, calculateAward, chooseOldestGroup, BONUS_METRICS } = require('./utils/bonusManager');
const { buildBonusTopImage } = require('./utils/bonusTopRenderer');
const bonusCommand = require('./commands/bonus');
const bonusProfileCommand = require('./commands/bonus-profile');
const interactionRouter = require('./utils/interactionRouter');
const colorManager = require('./utils/colorManager');
const { ChannelType } = require('discord.js');
const { EventEmitter } = require('node:events');
const sqlite3 = require('sqlite3').verbose();

async function main() {
  assert.deepEqual(calculateAward(250, 50, 300, 1), { leftover: 0, baseAward: 1, awardedPoints: 1, completed: 1 });
  assert.deepEqual(calculateAward(250, 50, 300, 1, 2), { leftover: 0, baseAward: 1, awardedPoints: 2, completed: 1 });
  assert.equal(calculateAward(650, 0, 300, 1).leftover, 50);

  const selected = chooseOldestGroup([
    { id: 1, role_id: 'role-a', created_at: 10 },
    { id: 2, role_id: 'role-b', created_at: 20 }
  ], ['role-a', 'role-b'], { 'role-a': 500, 'role-b': 100 });
  assert.equal(selected.role_id, 'role-b', 'role with earlier grant timestamp is selected');
  assert.equal(chooseOldestGroup([
    { id: 1, role_id: 'role-a', created_at: 10 },
    { id: 2, role_id: 'role-b', created_at: 20 }
  ], ['role-a', 'role-b'], { 'role-a': 500 }), null,
  'multiple group roles without complete grant history must not guess a target');
  assert.equal(bonusCommand.name, 'bonus');
  assert.deepEqual(bonusCommand.aliases, [], 'Arabic bonus name is no longer an alias for the settings command');
  assert.equal(bonusProfileCommand.name, 'بونس', 'Arabic bonus profile command is registered separately');
  assert.equal(bonusCommand.validateAvatarUrl('https://cdn.discordapp.com/icons/example.png').valid, true);
  assert.equal(bonusCommand.validateAvatarUrl('http://example.com/avatar.png').valid, false);
  assert.equal(bonusCommand.validateAvatarUrl('https://example.com/avatar.png').valid, false);
  assert.equal(bonusCommand.validateAvatarUrl('https://cdn.discordapp.com/icons/example.exe').valid, false);
  const topRows = bonusCommand.buildPublicRows(1, 3);
  assert.equal(topRows.length, 1, 'public board has no shared pagination controls');
  assert.equal(topRows[0].components.at(-1).data.custom_id, 'bonus:my-group', 'public board exposes a private My Group entry point');
  assert.deepEqual(bonusCommand.parseBonusCustomId('bonus:select:add-role'), {
    prefix: 'bonus', action: 'select', parts: ['add-role']
  });
  assert.deepEqual(bonusCommand.parseBonusCustomId('bonus:select:add-owner'), {
    prefix: 'bonus', action: 'select', parts: ['add-owner']
  });
  const voiceState = {
    guild: { afkChannelId: 'afk-channel' }, member: { user: { bot: false } },
    channelId: 'voice-channel', channel: { type: ChannelType.GuildVoice },
    serverMute: false, selfMute: false, serverDeaf: false, selfDeaf: false
  };
  assert.equal(bonusCommand.isEligibleVoiceState(voiceState), true, 'active unmuted voice participation is eligible for bonus');
  for (const flag of ['serverMute', 'selfMute', 'serverDeaf', 'selfDeaf']) {
    assert.equal(bonusCommand.isEligibleVoiceState({ ...voiceState, [flag]: true }), false, `${flag} excludes bonus voice time`);
  }
  assert.equal(bonusCommand.isEligibleVoiceState({ ...voiceState, channelId: 'afk-channel' }), false, 'AFK excludes bonus voice time');
  assert.equal(bonusCommand.isEligibleVoiceState({ ...voiceState, channel: { type: ChannelType.GuildStageVoice } }), false, 'Stage excludes bonus voice time');
  const manyGroups = Array.from({ length: 51 }, (_, index) => ({ id: index + 1, role_id: `role-${index + 1}`, role_name: `Role ${index + 1}` }));
  const groupPage = bonusCommand.buildGroupSelect('remove-points', manyGroups, 2);
  const pageMenu = groupPage.components[0].components[0];
  assert.equal(pageMenu.options.length, 3, 'point-control pages reserve one option for all groups');
  assert.match(groupPage.content, /صفحة 3\/3/, 'group pagination supports more than 25 groups');
  assert.ok(groupPage.components[1].components.some(component => component.data.custom_id === 'bonus:page:remove-points:1'),
    'previous page navigation is available');
  const settingsEmbed = bonusCommand.buildHomeEmbed({ name: 'Test Guild' }, {}, [], {}, false);
  assert.equal(settingsEmbed.data.color, Number.parseInt(colorManager.getColor().replace('#', ''), 16), 'bonus embed uses the shared bot-avatar color');
  const settingsWithAudit = bonusCommand.buildHomeEmbed({ name: 'Test Guild' }, { auditChannelId: 'audit-123' }, [], {}, false);
  assert.match(settingsWithAudit.data.description, /Audit Channel :\*\* <#audit-123>/, 'settings embed shows the configured audit channel');
  assert.deepEqual(bonusCommand.buildHomeRows().map(row => row.components.map(component => component.data.label)), [
    ['Managers', 'Rules', 'Board Channel', 'Audit Channel', 'Board Color'],
    ['Add Group', 'Manage Groups', 'Reset', 'Double Bonus', 'Publish / Update'],
    ['Audit Log']
  ]);
  assert.deepEqual(bonusCommand.buildPublicSettingsRows().slice(0, 2).map(row => row.components.map(component => component.data.label)), [
    ['Rules', 'Add Group', 'Manage Groups', 'Reset'],
    ['+ Add Points', '- Remove Points']
  ]);
  assert.equal(bonusCommand.buildGroupSelect('add-points', manyGroups).components[0].components[0].options[0].data.value, 'all',
    'point controls offer an all-groups option');
  assert.deepEqual(bonusCommand.buildPublicRows()[0].components.map(component => component.data.label),
    ['Settings', 'Double Bonus', 'Group Avatar', 'View Rankings', 'My Group']);
  assert.equal(bonusCommand.buildPublicRows()[0].components[0].data.custom_id, 'bonus:public-settings',
    'public board exposes a protected settings entry point');
  const ownerAvatarResult = bonusCommand.buildOwnerAvatarResult('Avatar updated.', true);
  assert.deepEqual(ownerAvatarResult.components, [], 'owner avatar results contain no buttons');
  assert.deepEqual(bonusCommand.buildActionResult('Double Bonus Updated', 'Done').components, [], 'double results do not reopen settings');
  const structuredResponse = bonusCommand.structurePrivateResponse({
    content: 'تأكيد إزالة النقاط\nالإجمالي الحالي: 100\nبعد الإزالة: 50',
    components: []
  });
  assert.equal(structuredResponse.content, undefined, 'private action responses do not use raw content');
  assert.equal(structuredResponse.embeds[0].data.title, 'Confirmation Required');
  assert.equal(structuredResponse.embeds[0].data.fields.length, 2, 'private responses expose labeled fields');
  assert.match(bonusCommand.boardCounter({ groups: 3, points: 725 }), /Total Groups\s*:\s*3\s+•\s+Total Points\s*:\s*725/);
  const fakeClient = new EventEmitter();
  fakeClient.guilds = { cache: new Map() };
  bonusCommand.registerInteractionHandler(fakeClient);
  assert.ok(interactionRouter.handlers.some(handler => handler.name === 'bonus-system'), 'bonus handler registers with the shared router');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ress-bonus-test-'));
  const databasePath = path.join(tempDir, 'bonus-test.sqlite');
  const db = new DatabaseManager(databasePath);
  let migrationDb;
  try {
    const legacyPath = path.join(tempDir, 'legacy-bonus.sqlite');
    await new Promise((resolve, reject) => {
      const raw = new sqlite3.Database(legacyPath, error => {
        if (error) return reject(error);
        raw.run(`CREATE TABLE bonus_rules (
          guild_id TEXT NOT NULL, metric TEXT NOT NULL, threshold INTEGER NOT NULL, points INTEGER NOT NULL,
          updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY (guild_id, metric)
        )`, createError => {
          if (createError) return reject(createError);
          raw.run('INSERT INTO bonus_rules (guild_id, metric, threshold, points, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)',
            ['legacy-guild', 'messages', 300, 1, 123456789, 'legacy-admin'], insertError => {
              if (insertError) return reject(insertError);
              raw.close(closeError => closeError ? reject(closeError) : resolve());
            });
        });
      });
    });
    migrationDb = new DatabaseManager(legacyPath);
    await migrationDb.initialize();
    const migratedRule = await migrationDb.get('SELECT activated_at FROM bonus_rules WHERE guild_id = ?', ['legacy-guild']);
    assert.equal(Number(migratedRule.activated_at), 123456789, 'legacy rule activation starts from its saved update timestamp');
    migrationDb.close();
    migrationDb = null;

    await db.initialize();
    const bonus = createBonusManager(db);
    const guildId = 'test-guild';
    const actorId = 'test-admin';
    const userId = 'test-user';
    const groupA = await bonus.addGroup(guildId, 'role-a', 'owner-a', actorId);
    const groupB = await bonus.addGroup(guildId, 'role-b', 'owner-b', actorId);
    await assert.rejects(
      bonus.addGroup(guildId, 'role-c', 'owner-a', actorId),
      error => error.message === 'OWNER_ALREADY_ASSIGNED',
      'one owner cannot be assigned to multiple active bonus groups'
    );
    const groupAddAudit = await db.get(`SELECT action, target_group_id FROM bonus_audit_log WHERE guild_id = ? AND action = 'group_add' AND target_group_id = ?`,
      [guildId, Number(groupA.id)]);
    assert.equal(groupAddAudit.action, 'group_add', 'group creation and its audit record are committed together');
    await bonus.updateGroup(guildId, Number(groupA.id), { avatar_url: 'https://cdn.example/avatar.png' }, actorId);
    const groupUpdateAudit = await db.get(`SELECT action FROM bonus_audit_log WHERE guild_id = ? AND action = 'group_update' AND source_group_id = ?`,
      [guildId, Number(groupA.id)]);
    assert.equal(groupUpdateAudit.action, 'group_update', 'group avatar update is audited atomically');
    const newMessageRule = await bonus.setRule(guildId, BONUS_METRICS.messages, 300, 1, actorId);
    assert.equal(newMessageRule.newlyActivated, true);
    const newVoiceRule = await bonus.setRule(guildId, BONUS_METRICS.voice, 100 * 60 * 60 * 1000, 1, actorId);
    assert.equal(newVoiceRule.newlyActivated, true);
    const voiceFirstStart = newVoiceRule.activatedAt + 1000;
    const voiceFirstEnd = voiceFirstStart + 50 * 60 * 60 * 1000;

    const historyUserId = 'role-history-user';
    await bonus.recordRoleChanges(guildId, historyUserId, {
      addedRoleIds: ['role-a', 'role-b'], changedAt: 1000
    });
    const storedRoleHistory = await bonus.getRoleGrantHistory(guildId, historyUserId, ['role-a', 'role-b']);
    assert.deepEqual(storedRoleHistory, { 'role-a': 1000, 'role-b': 1000 }, 'role history stores active group roles');
    await bonus.recordRoleChanges(guildId, historyUserId, { removedRoleIds: ['role-b'], changedAt: 2000 });
    assert.deepEqual(await bonus.getRoleGrantHistory(guildId, historyUserId, ['role-a', 'role-b']), { 'role-a': 1000 },
      'removed roles are excluded from active role history');
    await bonus.recordRoleChanges(guildId, historyUserId, { addedRoleIds: ['role-b'], changedAt: 3000 });
    assert.deepEqual(await bonus.getRoleGrantHistory(guildId, historyUserId, ['role-a', 'role-b']), { 'role-a': 1000, 'role-b': 3000 },
      're-added roles receive a new grant timestamp');

    const unassignedUserId = 'unassigned-user';
    const unassignedMessage = await bonus.addActivity({ guildId, userId: unassignedUserId, metric: BONUS_METRICS.messages,
      amount: 300, eventId: 'message:test-guild:unassigned-100', roleIds: [] });
    assert.equal(unassignedMessage.unassigned, true, 'unassigned message activity is ignored by bonus');
    assert.equal(unassignedMessage.awardedPoints, 0);
    assert.equal(await bonus.getBalance(guildId, unassignedUserId), undefined,
      'unassigned message activity does not create a bonus balance');
    const unassignedVoice = await bonus.addActivity({ guildId, userId: unassignedUserId, metric: BONUS_METRICS.voice,
      amount: 60 * 60 * 1000, eventId: 'voice:test-guild:unassigned-100', roleIds: [],
      voiceSession: { channelId: 'unassigned-voice', lastCheckpointAt: Date.now() } });
    assert.equal(unassignedVoice.unassigned, true, 'unassigned voice activity is ignored by bonus');
    assert.equal(await db.get('SELECT * FROM bonus_voice_sessions WHERE guild_id = ? AND user_id = ?', [guildId, unassignedUserId]), undefined,
      'unassigned voice activity does not persist a bonus voice cursor');
    await bonus.syncAssignment(guildId, unassignedUserId, Number(groupA.id), actorId, 'test-late-assignment');
    const replayedUnassigned = await bonus.addActivity({ guildId, userId: unassignedUserId, metric: BONUS_METRICS.messages,
      amount: 300, eventId: 'message:test-guild:unassigned-100', roleIds: ['role-a'] });
    assert.equal(replayedUnassigned.duplicate, true, 'unassigned activity cannot be replayed after later assignment');
    const assignedAfterUnassigned = await bonus.getBalance(guildId, unassignedUserId);
    assert.equal(Number(assignedAfterUnassigned.points), 0);
    assert.equal(Number(assignedAfterUnassigned.message_progress), 0);

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
      eventId: `voice:test-guild:test-user:${voiceFirstStart}:${voiceFirstEnd}`, roleIds: ['role-a', 'role-b'], roleGrantHistory: { 'role-a': 200, 'role-b': 100 },
      voiceSession: { channelId: 'test-voice-channel', lastCheckpointAt: voiceFirstEnd } });
    assert.equal(result.awardedPoints, 0);
    assert.equal(result.leftover, 50 * 60 * 60 * 1000);
    const savedVoiceCursor = await db.get('SELECT last_checkpoint_at FROM bonus_voice_sessions WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    assert.equal(Number(savedVoiceCursor.last_checkpoint_at), voiceFirstEnd, 'voice checkpoint persists atomically with recorded activity');
    const duplicateVoice = await bonus.addActivity({ guildId, userId, metric: BONUS_METRICS.voice, amount: 50 * 60 * 60 * 1000,
      eventId: `voice:test-guild:test-user:${voiceFirstStart}:${voiceFirstEnd}`, roleIds: ['role-a', 'role-b'], roleGrantHistory: { 'role-a': 200, 'role-b': 100 } });
    assert.equal(duplicateVoice.duplicate, true, 'voice checkpoint retry cannot double-count');

    await bonus.syncAssignment(guildId, userId, Number(groupA.id), actorId, 'test-transfer');
    let balance = await bonus.getBalance(guildId, userId);
    assert.equal(Number(balance.group_id), Number(groupA.id));
    assert.equal(Number(balance.points), 0, 'points reset when the member changes groups');
    assert.equal(Number(balance.message_progress), 0);
    assert.equal(Number(balance.voice_progress_ms), 0, 'voice progress resets when the member changes groups');
    assert.equal(balance.last_message_id, null, 'message cursor resets when the member changes groups');
    let leaderboard = await bonus.getLeaderboard(guildId, 10);
    const pointsA = Number(leaderboard.find(row => Number(row.id) === Number(groupA.id)).points);
    const pointsB = Number(leaderboard.find(row => Number(row.id) === Number(groupB.id)).points);
    assert.equal(pointsA, 0);
    assert.equal(pointsB, 0, 'old group has no duplicate balance');

    const archivedDoubleGroup = await bonus.addGroup(guildId, 'role-double-archived', 'owner-double', actorId);
    await db.run(`INSERT INTO bonus_balances
      (guild_id, user_id, group_id, points, message_progress, voice_progress_ms, last_message_id, last_message_at, updated_at)
      VALUES (?, ?, ?, 12, 44, 3600000, 'old-message', 123, ?)`,
    [guildId, 'archived-member', Number(archivedDoubleGroup.id), Date.now()]);
    await bonus.archiveGroup(guildId, Number(archivedDoubleGroup.id), actorId);
    const archivedBalance = await bonus.getBalance(guildId, 'archived-member');
    assert.equal(archivedBalance.group_id, null, 'archived members become unassigned');
    assert.equal(Number(archivedBalance.points), 0, 'archiving a group resets member points');
    assert.equal(Number(archivedBalance.message_progress), 0);
    assert.equal(Number(archivedBalance.voice_progress_ms), 0);
    assert.equal(archivedBalance.last_message_id, null);
    await assert.rejects(
      bonus.setMultiplier(guildId, { scope: 'group', groupId: Number(archivedDoubleGroup.id) }, actorId),
      error => error.message === 'GROUP_NOT_FOUND',
      'archived groups cannot receive a multiplier'
    );
    await assert.rejects(
      bonus.setMultiplier(guildId, { scope: 'group', groupId: 999999 }, actorId),
      error => error.message === 'GROUP_NOT_FOUND',
      'unknown groups cannot receive a multiplier'
    );
    await assert.rejects(
      bonus.clearMultiplier(guildId, { scope: 'group', groupId: Number(archivedDoubleGroup.id) }, actorId),
      error => error.message === 'GROUP_NOT_FOUND',
      'archived groups cannot clear a multiplier through the manager'
    );

    await bonus.setMultiplier(guildId, { scope: 'group', groupId: Number(groupA.id) }, actorId);
    await bonus.setMultiplier(guildId, { scope: 'user', groupId: Number(groupA.id), userId }, actorId);
    result = await bonus.addActivity({ guildId, userId, metric: BONUS_METRICS.messages, amount: 300,
      eventId: 'message:test-guild:102', roleIds: ['role-a'], roleGrantHistory: { 'role-a': 200 } });
    assert.equal(result.awardedPoints, 2, 'group and member doubles cap at x2 rather than x4 after a clean transfer');

    const voiceSecondStart = voiceFirstEnd + 1000;
    const voiceSecondEnd = voiceSecondStart + 50 * 60 * 60 * 1000;
    result = await bonus.addActivity({ guildId, userId, metric: BONUS_METRICS.voice, amount: 50 * 60 * 60 * 1000,
      eventId: `voice:test-guild:test-user:${voiceSecondStart}:${voiceSecondEnd}`, roleIds: ['role-a'], roleGrantHistory: { 'role-a': 200 } });
    assert.equal(result.awardedPoints, 0, 'voice progress starts from zero after a group transfer');

    const activeUserDoubles = await bonus.listActiveUserMultipliers(guildId, Number(groupA.id));
    assert.equal(activeUserDoubles.length, 1, 'user doubles remain stored for later manual deactivation');
    assert.equal(String(activeUserDoubles[0].user_id), userId);
    const activeGroupDouble = await bonus.getActiveGroupMultiplier(guildId, Number(groupA.id));
    assert.ok(activeGroupDouble, 'group double is queryable for status and manual stop');
    assert.equal(await bonus.clearMultiplier(guildId, { scope: 'user', groupId: Number(groupA.id), userId }, actorId), 1);
    assert.equal((await bonus.listActiveUserMultipliers(guildId, Number(groupA.id))).length, 0, 'manual stop disables but retains the multiplier history');

    const reset = await bonus.resetUser(guildId, Number(groupA.id), userId, actorId);
    assert.ok(reset.points > 0);
    balance = await bonus.getBalance(guildId, userId);
    assert.equal(Number(balance.points), 0);
    assert.equal(Number(balance.message_progress), 0);
    assert.equal(Number(balance.voice_progress_ms), 0);
    await bonus.syncAssignment(guildId, userId, Number(groupB.id), actorId, 'post-reset-transfer');
    balance = await bonus.getBalance(guildId, userId);
    assert.equal(Number(balance.points), 0, 'a transfer after a reset cannot resurrect cleared points');

    const manualAdd = await bonus.adjustGroupPoints(guildId, Number(groupB.id), 15, actorId);
    assert.deepEqual({ before: manualAdd.before, after: manualAdd.after, delta: manualAdd.delta }, { before: 0, after: 15, delta: 15 });
    const manualRemove = await bonus.adjustGroupPoints(guildId, Number(groupB.id), -6, actorId);
    assert.deepEqual({ before: manualRemove.before, after: manualRemove.after, delta: manualRemove.delta }, { before: 15, after: 9, delta: -6 });
    let groupBTop = await bonus.getLeaderboard(guildId, 10);
    assert.equal(Number(groupBTop.find(row => Number(row.id) === Number(groupB.id)).points), 9,
      'manual group points contribute to the leaderboard separately from member balances');
    const cappedManualRemove = await bonus.adjustGroupPoints(guildId, Number(groupB.id), -10, actorId);
    assert.equal(cappedManualRemove.after, 0, 'manual deductions cannot take the administrative ledger below zero');
    assert.equal(cappedManualRemove.delta, -9, 'oversized deductions are capped to available manual points');
    await bonus.adjustGroupPoints(guildId, Number(groupB.id), 9, actorId);

    await bonus.archiveGroup(guildId, Number(groupB.id), actorId);
    balance = await bonus.getBalance(guildId, userId);
    assert.equal(balance.group_id, null, 'archiving a group unassigns but preserves member balance');
    const restoredGroup = await bonus.addGroup(guildId, 'role-b', 'new-owner-b', actorId);
    assert.equal(Number(restoredGroup.id), Number(groupB.id), 'an archived role can be reactivated without losing history');
    groupBTop = await bonus.getLeaderboard(guildId, 10);
    assert.equal(Number(groupBTop.find(row => Number(row.id) === Number(groupB.id)).points), 9, 'archiving and reactivation retain the manual group ledger');
    const resetGroup = await bonus.resetGroup(guildId, Number(groupB.id), actorId);
    assert.equal(resetGroup.manualPoints, 24, 'reset snapshot preserves the separate add-points ledger');
    groupBTop = await bonus.getLeaderboard(guildId, 10);
    assert.equal(Number(groupBTop.find(row => Number(row.id) === Number(groupB.id)).points), 0, 'group reset also clears manual points');
    await bonus.setGlobalMultiplier(guildId, null, actorId);
    assert.ok(await bonus.getGlobalMultiplier(guildId), 'global double bonus remains active for future groups');
    await assert.rejects(() => bonus.setGlobalMultiplier(guildId, null, actorId), error => error.message === 'GLOBAL_DOUBLE_ALREADY_ACTIVE');
    const allPoints = await bonus.adjustAllGroupPoints(guildId, 3, actorId);
    assert.ok(allPoints.groups >= 1 && allPoints.delta >= 3, 'all-groups point adjustment applies to active groups');
    await bonus.clearGlobalMultiplier(guildId, actorId);
    assert.equal(await bonus.getGlobalMultiplier(guildId), null, 'global double bonus can be disabled');
    await assert.rejects(() => bonus.clearGlobalMultiplier(guildId, actorId), error => error.message === 'GLOBAL_DOUBLE_NOT_ACTIVE');

    const baselineGuild = 'activation-baseline-guild';
    const baselineGroup = await bonus.addGroup(baselineGuild, 'baseline-role', 'baseline-owner', actorId);
    await db.run(`INSERT INTO bonus_balances
      (guild_id, user_id, group_id, points, message_progress, voice_progress_ms, last_message_id, last_message_at, updated_at)
      VALUES (?, ?, ?, 0, 250, 0, '999999', ?, ?)`, [baselineGuild, 'baseline-user', baselineGroup.id, Date.now(), Date.now()]);
    const activatedBaseline = await bonus.setRule(baselineGuild, BONUS_METRICS.messages, 300, 1, actorId);
    assert.equal(activatedBaseline.newlyActivated, true);
    let baselineBalance = await bonus.getBalance(baselineGuild, 'baseline-user');
    assert.equal(Number(baselineBalance.message_progress), 0, 'first activation discards stale progress instead of counting historic activity');
    result = await bonus.addActivity({ guildId: baselineGuild, userId: 'baseline-user', metric: BONUS_METRICS.messages, amount: 299,
      eventId: 'message:activation-baseline-guild:1000000', roleIds: ['baseline-role'] });
    assert.equal(result.awardedPoints, 0);
    const editedBaselineRule = await bonus.setRule(baselineGuild, BONUS_METRICS.messages, 300, 2, actorId);
    assert.equal(editedBaselineRule.newlyActivated, false, 'editing an enabled rule keeps its original activation');
    baselineBalance = await bonus.getBalance(baselineGuild, 'baseline-user');
    assert.equal(Number(baselineBalance.message_progress), 299, 'editing an active rule retains its partial progress');
    result = await bonus.addActivity({ guildId: baselineGuild, userId: 'baseline-user', metric: BONUS_METRICS.messages, amount: 1,
      eventId: 'message:activation-baseline-guild:1000001', roleIds: ['baseline-role'] });
    assert.equal(result.awardedPoints, 2, 'only new messages after activation count, using the edited active rule');
    await bonus.addActivity({ guildId: baselineGuild, userId: 'baseline-user', metric: BONUS_METRICS.messages, amount: 299,
      eventId: 'message:activation-baseline-guild:1000002', roleIds: ['baseline-role'] });
    const disabledBaseline = await bonus.disableRule(baselineGuild, BONUS_METRICS.messages, actorId);
    assert.equal(disabledBaseline.clearedProgress, 299, 'disabling a metric clears only its partial progress');
    baselineBalance = await bonus.getBalance(baselineGuild, 'baseline-user');
    assert.equal(Number(baselineBalance.points), 2, 'disabling a metric retains points already awarded');
    result = await bonus.addActivity({ guildId: baselineGuild, userId: 'baseline-user', metric: BONUS_METRICS.messages, amount: 300,
      eventId: 'message:activation-baseline-guild:1000003', roleIds: ['baseline-role'] });
    assert.equal(result.noRule, true, 'messages received while the rule is disabled do not count');
    const reactivatedBaseline = await bonus.setRule(baselineGuild, BONUS_METRICS.messages, 300, 1, actorId);
    assert.equal(reactivatedBaseline.newlyActivated, true, 'turning the rule back on starts a new measurement window');
    result = await bonus.addActivity({ guildId: baselineGuild, userId: 'baseline-user', metric: BONUS_METRICS.messages, amount: 299,
      eventId: 'message:activation-baseline-guild:1000004', roleIds: ['baseline-role'] });
    assert.equal(result.awardedPoints, 0);
    result = await bonus.addActivity({ guildId: baselineGuild, userId: 'baseline-user', metric: BONUS_METRICS.messages, amount: 1,
      eventId: 'message:activation-baseline-guild:1000005', roleIds: ['baseline-role'] });
    assert.equal(result.awardedPoints, 1, 'post-reactivation messages begin at zero and earn a fresh step');

    const voiceBaselineRule = await bonus.setRule(baselineGuild, BONUS_METRICS.voice, 2 * 60 * 60 * 1000, 1, actorId);
    const voiceBefore = voiceBaselineRule.activatedAt - 2 * 60 * 60 * 1000;
    const voiceCrossingEnd = voiceBaselineRule.activatedAt + 60 * 60 * 1000;
    result = await bonus.addActivity({ guildId: baselineGuild, userId: 'baseline-user', metric: BONUS_METRICS.voice,
      amount: 3 * 60 * 60 * 1000, eventId: `voice:${baselineGuild}:baseline-user:${voiceBefore}:${voiceCrossingEnd}`,
      roleIds: ['baseline-role'], voiceSession: { channelId: 'baseline-voice', lastCheckpointAt: voiceCrossingEnd } });
    baselineBalance = await bonus.getBalance(baselineGuild, 'baseline-user');
    assert.equal(Number(baselineBalance.voice_progress_ms), 60 * 60 * 1000,
      'only the hour after voice-rule activation contributes to the voice progress');

    const oneMetricGuild = 'one-metric-guild';
    await bonus.addGroup(oneMetricGuild, 'single-role', 'single-owner', actorId);
    await bonus.setRule(oneMetricGuild, BONUS_METRICS.messages, 300, 1, actorId);
    await bonus.saveConfig(oneMetricGuild, { channelId: 'text-channel', topMessageId: 'top-message' }, actorId);
    assert.equal(await bonus.isReady(oneMetricGuild), true, 'message-only configuration is sufficient to publish and run the board');

    const outOfOrderGuild = 'out-of-order-messages-guild';
    const outOfOrderGroup = await bonus.addGroup(outOfOrderGuild, 'out-of-order-role', 'out-of-order-owner', actorId);
    await bonus.setRule(outOfOrderGuild, BONUS_METRICS.messages, 2, 1, actorId);
    const newer = await bonus.addActivity({ guildId: outOfOrderGuild, userId: 'out-of-order-user', metric: BONUS_METRICS.messages,
      amount: 1, eventId: 'message:out-of-order-messages-guild:200', roleIds: ['out-of-order-role'] });
    const older = await bonus.addActivity({ guildId: outOfOrderGuild, userId: 'out-of-order-user', metric: BONUS_METRICS.messages,
      amount: 1, eventId: 'message:out-of-order-messages-guild:100', roleIds: ['out-of-order-role'] });
    assert.equal(newer.awardedPoints, 0, 'the newer message contributes progress');
    assert.equal(older.awardedPoints, 0, 'a stale older message cannot award points');
    const outOfOrderBalance = await bonus.getBalance(outOfOrderGuild, 'out-of-order-user');
    assert.equal(Number(outOfOrderBalance.points), 0, 'out-of-order messages do not create a retroactive award');
    assert.equal(Number(outOfOrderBalance.message_progress), 1, 'only messages newer than the cursor advance progress');
    const duplicateEvent = await bonus.addActivity({ guildId: outOfOrderGuild, userId: 'out-of-order-user', metric: BONUS_METRICS.messages,
      amount: 1, eventId: 'message:out-of-order-messages-guild:100', roleIds: ['out-of-order-role'] });
    assert.equal(duplicateEvent.duplicate, true, 'replaying the same event is ignored by event_id');
    assert.equal(Number((await bonus.getBalance(outOfOrderGuild, 'out-of-order-user')).points), 0);

    const deductionGuild = 'deduction-order-guild';
    const deductionGroup = await bonus.addGroup(deductionGuild, 'deduction-role', 'deduction-owner', actorId);
    await db.run(`INSERT INTO bonus_balances (guild_id, user_id, group_id, points, message_progress, voice_progress_ms, updated_at)
      VALUES (?, ?, ?, ?, 0, 0, ?), (?, ?, ?, ?, 0, 0, ?)`,
    [deductionGuild, 'highest-member', deductionGroup.id, 7, Date.now(), deductionGuild, 'next-member', deductionGroup.id, 3, Date.now()]);
    await bonus.adjustGroupPoints(deductionGuild, Number(deductionGroup.id), 5, actorId);
    const groupDeduction = await bonus.adjustGroupPoints(deductionGuild, Number(deductionGroup.id), -10, actorId);
    assert.equal(groupDeduction.manualDelta, 0, 'general deductions do not alter member or add-point balances');
    assert.equal(groupDeduction.memberDelta, 0, 'general deductions do not affect contributor balances');
    assert.deepEqual(groupDeduction.deductions, [], 'general deductions never distribute across members');
    const remainingHighest = await bonus.getBalance(deductionGuild, 'highest-member');
    const remainingNext = await bonus.getBalance(deductionGuild, 'next-member');
    assert.equal(Number(remainingHighest.points), 7);
    assert.equal(Number(remainingNext.points), 3);
    const deductionTop = await bonus.getLeaderboard(deductionGuild, 10);
    assert.equal(Number(deductionTop[0].points), 5, 'group score falls by precisely the amount actually deducted');
    const memberDeduction = await bonus.adjustUserPoints(deductionGuild, Number(deductionGroup.id), 'highest-member', 2, actorId);
    assert.equal(memberDeduction.after, 5, 'member deduction changes only the selected member');
    assert.equal(Number((await bonus.getBalance(deductionGuild, 'next-member')).points), 3);
    assert.equal(Number((await bonus.getLeaderboard(deductionGuild, 10))[0].points), 3);
    const resetSnapshot = await bonus.resetGroup(deductionGuild, Number(deductionGroup.id), actorId);
    assert.ok(resetSnapshot.snapshotId, 'group reset stores a reversible snapshot');
    assert.equal(Number((await bonus.getLeaderboard(deductionGuild, 10))[0].points), 0, 'group reset starts from zero');
    await bonus.restoreGroupReset(deductionGuild, Number(deductionGroup.id), resetSnapshot.snapshotId, actorId);
    assert.equal(Number((await bonus.getBalance(deductionGuild, 'highest-member')).points), 5, 'reset can restore member points');
    assert.equal(Number((await bonus.getLeaderboard(deductionGuild, 10))[0].points), 3, 'reset restore reactivates saved deductions');

    await assert.rejects(db.transaction(async tx => {
      await tx.run('INSERT INTO bonus_audit_log (guild_id, action, details_json, created_at) VALUES (?, ?, ?, ?)',
        [guildId, 'rollback-test', '{}', Date.now()]);
      throw new Error('expected rollback');
    }));
    const rollbackCount = await db.get('SELECT COUNT(*) AS count FROM bonus_audit_log WHERE action = ?', ['rollback-test']);
    assert.equal(Number(rollbackCount.count), 0, 'transaction rolls back partial writes');

    const stressGuild = 'bonus-concurrency-guild';
    const stressGroup = await bonus.addGroup(stressGuild, 'stress-role', 'stress-owner', actorId);
    await bonus.setRule(stressGuild, BONUS_METRICS.messages, 1, 1, actorId);
    await Promise.all(Array.from({ length: 40 }, (_, index) => bonus.addActivity({
      guildId: stressGuild, userId: 'stress-user', metric: BONUS_METRICS.messages, amount: 1,
      eventId: `message:stress:${index}`, roleIds: ['stress-role']
    })));
    const stressBalance = await bonus.getBalance(stressGuild, 'stress-user');
    assert.equal(Number(stressBalance.points), 40, 'concurrent events are counted exactly once under load');
    assert.equal(Number(stressBalance.message_progress), 0);
    const auditPage = await bonus.listAuditLog(guildId, { page: 0, limit: 5, action: 'member_transfer' });
    assert.ok(Array.isArray(auditPage.rows) && auditPage.rows.length > 0, 'audit log supports paginated filtered reads');
    const migrationRow = await db.get('SELECT migration_key FROM bonus_migrations WHERE migration_key = ?', ['bonus-consistency-v1']);
    assert.ok(migrationRow, 'bonus consistency migration is recorded idempotently');

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
    migrationDb?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
