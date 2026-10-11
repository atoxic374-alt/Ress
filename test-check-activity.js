const assert = require('node:assert/strict');
const { DatabaseManager } = require('./utils/database');
const check = require('./commands/check');

async function main() {
  const db = new DatabaseManager(':memory:');
  await db.initialize();
  try {
    const today = new Date().toISOString().slice(0, 10);
    await db.updateDailyActivity(today, 'check-user', { messages: 103, voiceTime: 3_600_000 }, 'guild-a');
    await db.updateDailyActivity(today, 'check-user', { messages: 900, voiceTime: 9_000_000 }, 'guild-b');

    const stats = await check.getActivityTotals(db, 'guild-a', 'check-user', '2000-01-01');
    assert.equal(Number(stats.messages), 103, 'reads message activity for the requested guild');
    assert.equal(Math.floor(Number(stats.messages) / 10), 10, 'converts 10 messages into 1 XP');
    assert.equal(Number(stats.voiceTime), 3_600_000, 'reads voice duration in milliseconds for the requested guild');

    const now = Date.now();
    const client = { voiceSessions: new Map([['check-user', {
      guildId: 'guild-a', sessionStartTime: now - 120_000
    }]]) };
    assert.equal(check.getLiveVoiceDuration(client, 'check-user', 'guild-a', now - 60_000, now), 60_000,
      'counts live voice only within the requested period');
    assert.equal(check.getLiveVoiceDuration(client, 'check-user', 'guild-b', 0, now), 0,
      'does not leak active voice time across guilds');
    assert.equal(await check.getColorIndicator('check-user', client, db, 'guild-a'), '<:emoji_11:1429246636936138823>',
      'ranking queries work against guild-scoped activity');
  } finally {
    await db.closeAsync();
  }
  console.log('check activity tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
