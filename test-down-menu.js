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

async function testDeletedMenuChannelClearsStaleConfiguration() {
  const previousGetSettings = downManager.getSettings;
  const previousUpdateSettings = downManager.updateSettings;
  const settings = { menuChannel: 'deleted-channel', menuMessageId: 'old-message' };
  downManager.getSettings = () => settings;
  downManager.updateSettings = updated => Object.assign(settings, updated);
  const client = {
    channels: {
      fetch: async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003, status: 404 }); }
    }
  };
  try {
    assert.equal(await downCommand.createPermanentMenu(client, 'deleted-channel'), false);
    assert.equal(settings.menuChannel, null);
    assert.equal(settings.menuMessageId, null);
  } finally {
    downManager.getSettings = previousGetSettings;
    downManager.updateSettings = previousUpdateSettings;
  }
}

async function testMissingAccessDoesNotSendReplacementMenu() {
  const previousGetSettings = downManager.getSettings;
  const previousUpdateSettings = downManager.updateSettings;
  const settings = { menuChannel: 'private-channel', menuMessageId: 'existing-message' };
  let sendCalled = false;
  downManager.getSettings = () => settings;
  downManager.updateSettings = updated => Object.assign(settings, updated);
  const client = {
    channels: {
      fetch: async () => ({
        guild: { iconURL: () => null },
        messages: { fetch: async () => { throw Object.assign(new Error('Missing Access'), { code: 50001, status: 403 }); } },
        send: async () => { sendCalled = true; return { id: 'unexpected' }; }
      })
    }
  };
  try {
    assert.equal(await downCommand.createPermanentMenu(client, 'private-channel'), false);
    assert.equal(sendCalled, false);
    assert.equal(settings.menuChannel, 'private-channel');
  } finally {
    downManager.getSettings = previousGetSettings;
    downManager.updateSettings = previousUpdateSettings;
  }
}

testPermanentMenuRecoveryWithoutIcon()
  .then(testDeletedMenuChannelClearsStaleConfiguration)
  .then(testMissingAccessDoesNotSendReplacementMenu)
  .then(() => {
  console.log('down menu component serialization and recovery tests passed');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
