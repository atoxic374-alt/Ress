const assert = require('node:assert/strict');
const { buildDownMenuContainer } = require('./commands/down');
const downCommand = require('./commands/down');
const downManager = require('./utils/downManager');

for (const [label, guild] of [
  ['without server icon', { iconURL: () => null }],
  ['with server icon', { iconURL: () => 'https://cdn.discordapp.com/icons/123456789012345678/abcdef.png' }]
]) {
  const payload = buildDownMenuContainer(guild).toJSON();
  const serialized = JSON.stringify(payload);
  assert.ok(serialized.includes('down_action_remove_role'), `${label}: action buttons remain in the menu`);
  assert.ok(serialized.includes('down_settings_button'), `${label}: settings button remains in the menu`);
}

async function testPermanentMenuRecoveryWithoutIcon() {
  const previousGetSettings = downManager.getSettings;
  const previousUpdateSettings = downManager.updateSettings;
  const settings = { menuMessageId: null };
  let sentPayload;
  downManager.getSettings = () => settings;
  downManager.updateSettings = updated => Object.assign(settings, updated);
  const client = {
    channels: {
      fetch: async () => ({
        guild: { iconURL: () => null },
        messages: { fetch: async () => { throw Object.assign(new Error('not found'), { code: 10008 }); } },
        send: async payload => {
          payload.components.forEach(component => component.toJSON());
          sentPayload = payload;
          return { id: 'recovered-down-menu' };
        }
      })
    }
  };

  try {
    assert.equal(await downCommand.createPermanentMenu(client, 'menu-channel'), true);
    assert.equal(settings.menuMessageId, 'recovered-down-menu');
    assert.ok(sentPayload, 'recovery sends the replacement menu');
  } finally {
    downManager.getSettings = previousGetSettings;
    downManager.updateSettings = previousUpdateSettings;
  }
}

testPermanentMenuRecoveryWithoutIcon().then(() => {
  console.log('down menu component serialization and recovery tests passed');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
