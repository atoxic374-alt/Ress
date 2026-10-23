const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DatabaseManager } = require('./utils/database');
const { ChannelType } = require('discord.js');

// Keep this integration test isolated from the production SQLite file.
const databaseModule = require('./utils/database');
const testDb = new DatabaseManager(':memory:');
databaseModule.dbManager = testDb;

const gm = require('./utils/groupManager');
const { handleInternalMessage } = require('./utils/groupInternal');
const groupCommand = require('./commands/groups');
const interactionRouter = require('./utils/interactionRouter');

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


async function testCreateGroupRoleDefaults() {
  const guildId = '1000000000000000200';
  const textCategoryId = '1000000000000000201';
  const voiceCategoryId = '1000000000000000202';
  const roleOptions = [];
  const roleCache = new Map();
  const owner = {
    id: OWNER,
    user: { id: OWNER, bot: false },
    roles: {
      cache: new Map(),
      add: async role => owner.roles.cache.set(role.id, role),
      remove: async role => owner.roles.cache.delete(role.id)
    }
  };
  const permissions = { has: () => true };
  const category = { type: ChannelType.GuildCategory, permissionsFor: () => permissions };
  const channelsCache = new Map([[textCategoryId, category], [voiceCategoryId, category]]);
  const guild = {
    id: guildId,
    ownerId: OWNER,
    members: { me: { permissions, roles: { highest: { position: 100 } } }, fetch: async id => String(id) === OWNER ? owner : null },
    roles: {
      cache: roleCache,
      everyone: { id: guildId },
      create: async options => {
        roleOptions.push(options);
        const role = { id: 'new-group-role', name: options.name, position: 1, delete: async () => {} };
        roleCache.set(role.id, role);
        return role;
      },
      fetch: async id => roleCache.get(String(id)) || null
    },
    channels: {
      cache: channelsCache,
      fetch: async id => channelsCache.get(String(id)) || null,
      create: async options => {
        const id = options.type === ChannelType.GuildVoice ? 'created-voice-channel' : 'created-text-channel';
        const channel = { id, name: options.name, type: options.type, permissionOverwrites: { set: async () => {} }, delete: async () => {} };
        channelsCache.set(id, channel);
        return channel;
      }
    }
  };
  await gm.saveSettings(guildId, {
    enabled: true,
    chatMode: 'channels',
    textCategoryId,
    voiceCategoryId
  }, ACTOR);
  const group = await gm.createGroup(guild, { name: 'نسور الشمال', ownerId: OWNER }, ACTOR);
  assert.equal(roleOptions.length, 1);
  assert.equal(roleOptions[0].name, 'نسور الشمال', 'group role name matches the group name without a prefix');
  assert.equal(Object.prototype.hasOwnProperty.call(roleOptions[0], 'color'), false, 'Discord assigns the default role color');
  assert.equal(group.role_id, 'new-group-role');
  global.groupRoleGrantBypass?.clear?.();
}

async function testGroupCommandGuideAndMusicApi() {
  const guide = groupCommand.buildGroupCommandGuide({ name: 'نسور الشمال' }, { extraPermissions: true });
  assert.match(guide, /`تحكم`/);
  assert.match(guide, /`مسؤول إزالة @عضو`/);
  assert.match(guide, /`عقوبة @عضو`/);
  assert.doesNotMatch(guide, /:/, 'member-facing group commands do not require a colon prefix');
  const tempVoice = require('./commands/temp');
  assert.equal(typeof tempVoice.ensureMusicBotInVoiceRoom, 'function');
  assert.equal(typeof tempVoice.ensureMusicBotInVoice, 'undefined');
  const setupCommand = require('./commands/setup');
  const setupHelp = await setupCommand.execute({ reply: async content => content }, ['help']);
  assert.doesNotMatch(setupHelp, /`:/, 'setup help does not hardcode colon command prefixes');
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

async function testDashboardPublishers() {
  const guildId = 'dashboard-publisher-guild';
  await insertGroup({ guildId, name: 'Member panel group' });
  const guild = { id: guildId, client: { user: { id: 'dashboard-bot' } }, iconURL: () => 'https://cdn.discordapp.com/icons/123456789012345678/abcdef.png' };
  const messages = new Map();
  let sends = 0;
  let edits = 0;
  let embedFallbacks = 0;
  const channel = {
    id: 'dashboard-channel',
    messages: { fetch: async () => new Map(messages) },
    send: async payload => {
      if (payload.embeds) embedFallbacks += 1;
      for (const component of payload.components || []) component.toJSON();
      const message = {
        id: `dashboard-message-${++sends}`,
        author: { id: 'dashboard-bot' },
        createdTimestamp: sends,
        components: payload.components,
        edit: async updated => { edits += 1; message.components = updated.components; return message; }
      };
      messages.set(message.id, message);
      return message;
    }
  };

  await groupCommand.sendAdminControlPanel(channel, guild);
  const adminComponents = JSON.stringify([...messages.values()][0]?.components || []);
  assert.ok(adminComponents.includes('إدارة القروبات'), 'admin dashboard title is Arabic');
  assert.ok(adminComponents.includes('حذف') && adminComponents.includes('تصفير الكل'));
  assert.doesNotMatch(adminComponents, /استخدم الأزرار لإدارة القروبات/);
  assert.ok(adminComponents.includes('1465336647477493894') && adminComponents.includes('1465373714060415180'), 'admin action buttons reuse matching role-panel emojis');
  assert.ok(adminComponents.indexOf('groups_admin:delete') < adminComponents.indexOf('groups_admin:reset'), 'Delete appears above Reset');
  const adminPayload = groupCommand.controlPayload(guild);
  const adminButtons = [];
  const collectButtons = value => {
    if (!value || typeof value !== 'object') return;
    if (value.custom_id) adminButtons.push(value);
    for (const child of Object.values(value)) collectButtons(child);
  };
  collectButtons(JSON.parse(JSON.stringify(adminPayload.components[0])));
  assert.equal(adminButtons.find(item => item.custom_id === 'groups_admin:create')?.style, 2, 'ordinary management buttons use Secondary styling');
  assert.equal(adminButtons.find(item => item.custom_id === 'groups_admin:delete')?.style, 4, 'Delete remains Danger');
  assert.equal(adminButtons.find(item => item.custom_id === 'groups_admin:reset')?.style, 4, 'Reset remains Danger');
  assert.equal(adminButtons.find(item => item.custom_id === 'groups_admin:resetall')?.style, 4, 'Reset All remains Danger');
  await groupCommand.sendAdminControlPanel(channel, guild);
  assert.equal(sends, 1, 'admin panel is updated instead of duplicated');
  assert.equal(edits, 1);

  const first = await groupCommand.sendMemberControlPanels(channel, guild);
  assert.deepEqual({ total: first.total, published: first.published, overview: first.overview }, { total: 1, published: 1, overview: true });
  const afterFirstPublish = sends;
  const second = await groupCommand.sendMemberControlPanels(channel, guild);
  assert.deepEqual({ total: second.total, published: second.published, overview: second.overview }, { total: 1, published: 1, overview: true });
  assert.equal(sends, afterFirstPublish, 'member group and overview panels are updated instead of duplicated');
  assert.equal(embedFallbacks, 0, 'admin/member dashboards serialize as valid component payloads without legacy fallback');


  const topGuild = { ...guild, members: { cache: new Map(), fetch: async () => null }, iconURL: () => null, bannerURL: () => null };
  const topPayload = await groupCommand.buildTopGroupsPayload(topGuild, { viewerId: OWNER, channelId: 'dashboard-channel' });
  assert.equal(topPayload.files.length, 1, 'top groups is rendered as an attached image');
  assert.equal(topPayload.components.length, 1, 'top board has one compact navigation row');
  const topButtonIds = topPayload.components.flatMap(row => row.toJSON().components).map(component => component.custom_id);
  assert.deepEqual(topButtonIds, ['groups_top:rank', 'groups_top:group', 'groups_top:manage']);
  assert.equal(topButtonIds.includes('groups_top:refresh'), false, 'the top board no longer exposes a manual refresh button');
  assert.equal(topPayload.flags, undefined, 'top image is not a Components V2 container');

  const legacyMessage = {
    author: { id: 'dashboard-bot' },
    createdTimestamp: 1,
    flags: { has: value => value === require('discord.js').MessageFlags.IsComponentsV2 },
    components: [{ customId: 'groups_top:refresh' }],
    delete: async () => { legacyDeleted += 1; }
  };
  let topSends = 0, topEdits = 0, legacyDeleted = 0;
  const topMessages = new Map([['legacy-top', legacyMessage]]);
  const topChannel = {
    id: 'top-dashboard-channel',
    messages: { fetch: async () => new Map(topMessages) },
    send: async payload => {
      topSends += 1;
      const message = { author: { id: 'dashboard-bot' }, createdTimestamp: topSends + 1, components: payload.components, edit: async updated => { topEdits += 1; message.components = updated.components; return message; } };
      topMessages.set(`top-${topSends}`, message);
      return message;
    }
  };
  const refreshIntervals = [];
  const originalSetInterval = global.setInterval;
  global.setInterval = (callback, milliseconds) => { refreshIntervals.push(milliseconds); return { unref() {} }; };
  try {
    await groupCommand.sendTopGroupsPanel(topChannel, topGuild);
    await groupCommand.sendTopGroupsPanel(topChannel, topGuild);
  } finally {
    global.setInterval = originalSetInterval;
  }
  assert.equal(topSends, 1, 'legacy V2 top board is replaced with a normal image message');
  assert.equal(legacyDeleted, 1, 'old V2 board is removed only after the image message was sent');
  assert.equal(topEdits, 1, 'a normal top-image message refreshes in place');
  assert.deepEqual(refreshIntervals, [30_000], 'the top board schedules one automatic refresh every 30 seconds');

  let oldBoardEditAttempts = 0, oldBoardDeleteCount = 0, migratedBoardSends = 0;
  const oldV2TopMessage = {
    author: { id: 'dashboard-bot' }, createdTimestamp: 1,
    flags: { has: value => value === require('discord.js').MessageFlags.IsComponentsV2 },
    components: [{ customId: 'groups_top:refresh' }],
    edit: async () => { oldBoardEditAttempts += 1; throw new Error('cannot convert V2 message by editing'); },
    delete: async () => { oldBoardDeleteCount += 1; }
  };
  const oldV2Messages = new Map([['old-v2-top', oldV2TopMessage]]);
  const oldV2Channel = {
    id: 'old-v2-top-channel',
    messages: { fetch: async () => new Map(oldV2Messages) },
    send: async payload => {
      migratedBoardSends += 1;
      const message = { author: { id: 'dashboard-bot' }, components: payload.components, edit: async updated => { message.components = updated.components; return message; } };
      oldV2Messages.set('new-image-top', message);
      return message;
    }
  };
  const oldBoardRefresh = {
    customId: 'groups_top:refresh', guild: topGuild, channel: oldV2Channel, channelId: oldV2Channel.id,
    message: oldV2TopMessage, user: { id: OWNER }, deferUpdate: async () => {}
  };
  await groupCommand.handleInteraction(oldBoardRefresh);
  assert.equal(migratedBoardSends, 1, 'refresh replaces an old V2 top board instead of trying an invalid edit');
  assert.equal(oldBoardDeleteCount, 1);
  assert.equal(oldBoardEditAttempts, 0);

  const emptyGuild = { ...guild, id: 'dashboard-empty-guild' };
  const emptyMessages = new Map();
  let emptySends = 0;
  const emptyChannel = {
    ...channel,
    id: 'empty-dashboard-channel',
    messages: { fetch: async () => new Map(emptyMessages) },
    send: async payload => {
      for (const component of payload.components || []) component.toJSON();
      const message = { id: `empty-${++emptySends}`, author: { id: 'dashboard-bot' }, components: payload.components };
      emptyMessages.set(message.id, message);
      return message;
    }
  };
  const empty = await groupCommand.sendMemberControlPanels(emptyChannel, emptyGuild);
  assert.equal(empty.total, 0);
  assert.equal(empty.overview, true, 'an explanatory member panel is still published when there are no groups');
}

async function testSetupDashboardSerialization() {
  const botId = 'setup-dashboard-bot';
  const ownerId = '100000000000000021';
  const botMember = { id: botId, permissions: { has: () => true }, roles: { highest: { position: 20 } } };
  const guild = {
    id: 'setup-dashboard-guild',
    ownerId,
    client: { user: { id: botId } },
    iconURL: () => 'https://cdn.discordapp.com/icons/123456789012345678/abcdef.png',
    members: { me: botMember, fetchMe: async () => botMember },
    roles: { cache: new Map(), fetch: async () => null },
    channels: { cache: new Map(), fetch: async () => null }
  };
  const messages = new Map();
  let sends = 0;
  let edits = 0;
  const serialize = components => (components || []).map(component => component.toJSON());
  const channel = {
    id: 'setup-dashboard-channel',
    messages: { fetch: async () => new Map(messages) },
    send: async payload => {
      const message = {
        id: `setup-panel-${++sends}`,
        author: { id: botId },
        createdTimestamp: Date.now() + sends,
        components: serialize(payload.components),
        edit: async updated => { edits += 1; message.components = serialize(updated.components); return message; }
      };
      messages.set(message.id, message);
      return message;
    }
  };
  const member = { id: ownerId, guild, roles: { cache: new Map() } };
  const message = { guild, channel, member, author: { id: ownerId } };
  const context = { client: { user: { id: botId } } };
  await groupCommand.execute(message, ['setup'], context);
  assert.equal(sends, 2, 'both setup pages serialize and publish');

  delete require.cache[require.resolve('./commands/groups')];
  delete require.cache[require.resolve('./commands/setup')];
  const setupCommand = require('./commands/setup');
  await setupCommand.execute(message, ['groups'], context);
  assert.equal(sends, 4, 'each setup command invocation publishes two new panel messages');
  assert.equal(edits, 0, 'setup command leaves existing panel messages unchanged');
}

async function testDeleteCommandFlow() {
  const guildId = 'delete-command-guild';
  const groupId = await insertGroup({ guildId, name: 'Delete flow group' });
  const guild = { id: guildId, ownerId: OWNER, iconURL: () => 'https://cdn.example/guild.png', channels: { cache: new Map(), fetch: async () => null }, roles: { cache: new Map() } };
  const member = { id: OWNER, guild, roles: { cache: new Map() } };
  const client = new EventEmitter();
  interactionRouter.clear();
  groupCommand.registerInteractionHandler(client);

  function makeInteraction(customId, type, values = []) {
    const interaction = {
      customId,
      guild,
      client,
      member,
      user: { id: OWNER },
      values,
      replied: false,
      deferred: false,
      isButton: () => type === 'button',
      isStringSelectMenu: () => type === 'stringSelect',
      isModalSubmit: () => type === 'modal',
      showModal: async modal => { interaction.response = modal.toJSON(); return interaction.response; },
      reply: async payload => {
        for (const component of payload.components || []) component.toJSON();
        interaction.response = payload;
        interaction.replied = true;
        return payload;
      }
    };
    return interaction;
  }

  const openCreate = makeInteraction('groups_admin:create', 'button');
  assert.equal(await interactionRouter.route(openCreate), true);
  assert.equal(openCreate.response.title, 'إنشاء قروب', 'create modal is built and serialized successfully');

  const openDelete = makeInteraction('groups_admin:delete', 'button');
  assert.equal(await interactionRouter.route(openDelete), true);
  assert.ok(JSON.stringify(openDelete.response.components[0].toJSON()).includes(`groups_admin_select:delete`));

  const chooseGroup = makeInteraction('groups_admin_select:delete', 'stringSelect', [String(groupId)]);
  assert.equal(await interactionRouter.route(chooseGroup), true);
  const confirmation = chooseGroup.response.components[0].toJSON();
  assert.ok(JSON.stringify(confirmation).includes(`groups_admin_confirm:delete:${groupId}`));

  let commandPayload = null;
  const createCommand = require('./commands/create');
  const deleteCommand = require('./commands/delete');
  assert.equal(createCommand.name, 'create');
  assert.equal(deleteCommand.name, 'delete');
  let createCollector = null;
  let createMessage = null;
  const commandMessage = {
    guild,
    member,
    author: { id: OWNER },
    channel: {
      id: 'delete-command-text-channel',
      send: async payload => {
        commandPayload = payload;
        if (!JSON.stringify(payload).includes('group_create_launch:')) return payload;
        createMessage = {
          edit: async updated => { commandPayload = updated; return createMessage; },
          createMessageComponentCollector: options => {
            createCollector = new EventEmitter();
            createCollector.options = options;
            createCollector.stop = reason => { createCollector.reason = reason; createCollector.emit('end', [], reason); };
            createCollector.dispatch = async interaction => {
              for (const listener of createCollector.listeners('collect')) await listener(interaction);
            };
            return createCollector;
          }
        };
        return createMessage;
      }
    },
    reply: async content => content
  };
  await createCommand.execute(commandMessage, [], { client });
  const createPayloadJson = JSON.stringify(commandPayload);
  assert.equal(commandPayload.flags, require('discord.js').MessageFlags.IsComponentsV2, 'create command is sent as a Components V2 card');
  assert.ok(createPayloadJson.includes('Create Group') && createPayloadJson.includes('افتح النموذج') && createPayloadJson.includes('https://cdn.example/guild.png'), 'create card is concise and includes a thumbnail');
  assert.ok(createPayloadJson.includes('group_create_launch:') && createPayloadJson.includes('"style":2'), 'create button is Secondary and owned by a collector');
  const createCustomId = createPayloadJson.match(/"custom_id":"([^"]+)"/)?.[1];
  assert.ok(createCustomId.startsWith('group_create_launch:') && !createCustomId.startsWith('groups_'), 'create collector custom ID is isolated from the central component router');
  assert.equal(createCollector.options.time, 60_000, 'create collector expires after one minute');
  let openedModal = null;
  await createCollector.dispatch({
    customId: createCustomId, guild, client, member, user: { id: OWNER }, replied: false, deferred: false,
    showModal: async modal => { openedModal = modal.toJSON(); },
    reply: async () => { throw new Error('authorized creator should not receive a denial'); }
  });
  assert.equal(openedModal.custom_id, 'groups_modal:create', 'collector opens the same create-modal submit route as the dashboard');
  assert.equal(createCollector.reason, 'used', 'the Create collector stops after the first successful use');
  assert.ok(JSON.stringify(commandPayload).includes('"disabled":true'), 'the used button is disabled');
  await deleteCommand.execute(commandMessage, ['Delete', 'flow', 'group'], { client });
  assert.ok(JSON.stringify(commandPayload).includes('groups_admin_select:delete'), 'delete command uses the existing protected group selector and confirmation route');
  assert.ok(JSON.stringify(commandPayload).includes('Delete flow group'), 'delete command can target a group by name');

  let deniedReply = '';
  const unauthorizedMessage = {
    ...commandMessage,
    member: { id: USER_A, guild, roles: { cache: { some: () => false } } },
    author: { id: USER_A },
    reply: async content => { deniedReply = content; return content; }
  };
  await createCommand.execute(unauthorizedMessage, [], { client });
  assert.equal(deniedReply, 'لا تملك الصلاحية.', 'create is restricted to group-system managers');
  await deleteCommand.execute(unauthorizedMessage, [], { client });
  assert.equal(deniedReply, 'لا تملك الصلاحية.', 'delete is restricted to group-system managers');

  const confirmDelete = makeInteraction(`groups_admin_confirm:delete:${groupId}`, 'button');
  assert.equal(await interactionRouter.route(confirmDelete), true);
  assert.equal((await gm.getGroup(guildId, groupId)).status, 'deleted');
  assert.equal(confirmDelete.response.content, 'تم حذف القروب.');
  interactionRouter.clear();
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

function responseText(value) {
  if (typeof value === 'string') return value;
  const find = node => {
    if (!node || typeof node !== 'object') return null;
    if (typeof node.content === 'string') return node.content;
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) { for (const item of child) { const found = find(item); if (found !== null) return found; } }
      else { const found = find(child); if (found !== null) return found; }
    }
    return null;
  };
  return find(value);
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

  const bareOutsideGroup = parserMessage(guild, 'قروبي');
  bareOutsideGroup.message.channel.id = 'unlinked-channel';
  assert.equal(await handleInternalMessage(bareOutsideGroup.message, { prefix: null }), false,
    'bare command words outside group channels remain ordinary chat');
  assert.deepEqual(bareOutsideGroup.replies, []);

  const englishAdd = parserMessage(guild, `:add ${USER_A}`);
  assert.equal(await handleInternalMessage(englishAdd.message), true);
  assert.equal(responseText(englishAdd.replies[0]), 'تمت إضافة العضو.');
  assert.deepEqual((await gm.getGroup(guildId, groupId)).memberIds, [OWNER, USER_A]);

  const barePermission = parserMessage(guild, 'صلاحية');
  assert.equal(await groupCommand.handleInternalMessage(barePermission.message, { prefix: null }), true);
  assert.equal(typeof barePermission.replies[0], 'object', 'bare permission command enters the permission flow handler');

  const bareAdd = parserMessage(guild, `إضافة ${USER_A}`);
  assert.equal(await handleInternalMessage(bareAdd.message, { prefix: null }), true,
    'group commands accept bare command names without a colon or configured prefix');
  assert.equal(responseText(bareAdd.replies[0]), 'تمت إضافة العضو.');

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
  assert.equal(responseText(punishWhileDisabled.replies[0]), 'الصلاحيات الإضافية متوقفة.');

  await insertGroup({ guildId, name: 'Ambiguous channel', ownerId: USER_C, memberIds: [USER_C], textChannelId: 'parser-channel' });
  assert.equal(await gm.getGroupForChannel(guildId, 'parser-channel'), null, 'shared channel links are rejected rather than routing to the first group');
}


async function testManualGroupPointAdjustments() {
  const guildId = 'manual-points-guild';
  const groupId = await insertGroup({ guildId, name: 'Manual points', memberIds: [USER_A], points: 20 });
  const groupAdd = await gm.adjustGroupPoints(guildId, groupId, 30, ACTOR);
  assert.deepEqual([groupAdd.before, groupAdd.after, groupAdd.delta], [20, 50, 30]);
  assert.equal((await gm.listMemberPoints(guildId, groupId, 10)).length, 0, 'group-total bonus does not silently award individual member points');
  const groupRemove = await gm.adjustGroupPoints(guildId, groupId, -10, ACTOR);
  assert.deepEqual([groupRemove.before, groupRemove.after], [50, 40]);
  await assert.rejects(gm.adjustGroupPoints(guildId, groupId, -41, ACTOR), error => error.message === 'INSUFFICIENT_GROUP_POINTS');

  const memberAdd = await gm.adjustMemberPoints(guildId, groupId, USER_A, 15, ACTOR);
  assert.deepEqual([memberAdd.before, memberAdd.after, memberAdd.groupBefore, memberAdd.groupAfter], [0, 15, 40, 55]);
  await testDb.run('UPDATE group_member_points SET messages = 7 WHERE guild_id = ? AND group_id = ? AND user_id = ?', [guildId, groupId, USER_A]);
  const memberExtra = await gm.adjustMemberPoints(guildId, groupId, USER_A, 5, ACTOR);
  assert.deepEqual([memberExtra.before, memberExtra.after, memberExtra.groupAfter], [15, 20, 60]);
  const row = (await gm.listMemberPoints(guildId, groupId, 10))[0];
  assert.equal(Number(row.messages), 7, 'manual bonuses preserve activity counters');
  const memberRemove = await gm.adjustMemberPoints(guildId, groupId, USER_A, -10, ACTOR);
  assert.deepEqual([memberRemove.before, memberRemove.after, memberRemove.groupAfter], [20, 10, 50]);
  await assert.rejects(gm.adjustMemberPoints(guildId, groupId, USER_A, -11, ACTOR), error => error.message === 'INSUFFICIENT_MEMBER_POINTS');
  await assert.rejects(gm.adjustMemberPoints(guildId, groupId, USER_B, 1, ACTOR), error => error.message === 'MEMBER_NOT_IN_GROUP');
  const auditRows = await testDb.all("SELECT action FROM group_audit_log WHERE guild_id = ? AND action LIKE 'manual_%' ORDER BY id", [guildId]);
  assert.equal(auditRows.length, 5, 'each successful manual group/member adjustment is audited atomically');


  const allGuildId = 'manual-all-points-guild';
  await insertGroup({ guildId: allGuildId, name: 'All points one', points: 20 });
  await insertGroup({ guildId: allGuildId, name: 'All points two', ownerId: USER_B, points: 5 });
  const allAdded = await gm.adjustAllGroupPoints(allGuildId, 10, ACTOR);
  assert.deepEqual([allAdded.before, allAdded.after, allAdded.delta, allAdded.groups, allAdded.changedGroups], [25, 45, 20, 2, 2]);
  const allRemoved = await gm.adjustAllGroupPoints(allGuildId, -20, ACTOR);
  assert.deepEqual([allRemoved.before, allRemoved.after, allRemoved.delta, allRemoved.changedGroups], [45, 10, -35, 2], 'bulk removal caps each group at zero without rolling back other groups');
  const allRemovedToZero = await gm.adjustAllGroupPoints(allGuildId, -100, ACTOR);
  assert.deepEqual([allRemovedToZero.before, allRemovedToZero.after, allRemovedToZero.delta], [10, 0, -10]);
  await assert.rejects(gm.adjustAllGroupPoints(allGuildId, -1, ACTOR), error => error.message === 'NO_POINTS_TO_REMOVE');
}


function mockGroupInteraction({ customId, guild, userId = ACTOR, channelId = null, values = null, amount = null, message = null }) {
  const state = {};
  const interaction = {
    customId, guild, client: {}, user: { id: userId }, member: { id: userId, guild: { ownerId: '100000000000000099' }, roles: { cache: { some: () => false } } },
    channelId, values, message, state,
    fields: { getTextInputValue: () => String(amount ?? '') },
    reply: async payload => { state.reply = payload; interaction.replied = true; return payload; },
    showModal: async modal => { state.modal = modal.toJSON(); return modal; },
    update: async payload => { state.update = payload; interaction.replied = true; return payload; },
    deferReply: async () => { interaction.deferred = true; },
    deferUpdate: async () => { state.deferredUpdate = true; interaction.deferred = true; },
    editReply: async payload => { state.editReply = payload; interaction.replied = true; return payload; },
    followUp: async payload => { state.followUp = payload; return payload; }
  };
  return interaction;
}
async function testTopBonusControls() {
  const guildId = 'top-bonus-workflow-guild';
  const groupId = await insertGroup({ guildId, name: 'Top bonus test', memberIds: [USER_A], points: 10 });
  await gm.saveSettings(guildId, { systemUsers: [ACTOR] });
  const guild = {
    id: guildId, name: 'Test guild', ownerId: '100000000000000099', iconURL: () => null,
    client: { user: { id: 'test-bot' } }, channels: { cache: new Map(), fetch: async () => null },
    members: { cache: new Map(), fetch: async () => null }, roles: { cache: new Map(), fetch: async () => null }
  };
  const denied = mockGroupInteraction({ customId: 'groups_bonus:group-add', guild, userId: USER_B });
  await groupCommand.handleInteraction(denied);
  assert.ok(denied.state.reply?.content?.includes('لا تملك صلاحية'), 'bonus controls are restricted to group-system managers');

  const deniedManage = mockGroupInteraction({ customId: 'groups_top:manage', guild, userId: USER_B });
  await groupCommand.handleInteraction(deniedManage);
  assert.ok(deniedManage.state.reply?.content?.includes('لا تملك صلاحية'), 'Manage menu is restricted to group-system managers');
  const manage = mockGroupInteraction({ customId: 'groups_top:manage', guild, channelId: 'top-bonus-channel' });
  await groupCommand.handleInteraction(manage);
  const manageJson = JSON.stringify(manage.state.reply?.components?.map(component => component.toJSON()));
  for (const action of ['group-add', 'group-remove', 'all-add', 'all-remove', 'member-add', 'member-remove']) {
    assert.ok(manageJson.includes(`groups_bonus:${action}`), `Manage menu contains ${action}`);
  }

  const openAdd = mockGroupInteraction({ customId: 'groups_bonus:group-add', guild, channelId: 'top-bonus-channel' });
  await groupCommand.handleInteraction(openAdd);
  assert.ok(JSON.stringify(openAdd.state.reply?.components?.map(component => component.toJSON())).includes('groups_bonus_select:group-add:0'));
  const selectAdd = mockGroupInteraction({ customId: 'groups_bonus_select:group-add:0', guild, channelId: 'top-bonus-channel', values: [String(groupId)] });
  await groupCommand.handleInteraction(selectAdd);
  assert.equal(selectAdd.state.modal?.custom_id, `groups_bonus_modal:group-add:${groupId}`);
  const submitAdd = mockGroupInteraction({ customId: `groups_bonus_modal:group-add:${groupId}`, guild, channelId: 'top-bonus-channel', amount: '25' });
  await groupCommand.handleInteraction(submitAdd);
  assert.ok(submitAdd.state.editReply?.content?.includes('إضافة'));
  assert.equal(Number((await gm.getGroup(guildId, groupId)).points), 35, 'top group bonus button updates the group-system score');

  const openRemove = mockGroupInteraction({ customId: 'groups_bonus:group-remove', guild, channelId: 'top-bonus-channel' });
  await groupCommand.handleInteraction(openRemove);
  const selectRemove = mockGroupInteraction({ customId: 'groups_bonus_select:group-remove:0', guild, channelId: 'top-bonus-channel', values: [String(groupId)] });
  await groupCommand.handleInteraction(selectRemove);
  const submitRemove = mockGroupInteraction({ customId: `groups_bonus_modal:group-remove:${groupId}`, guild, channelId: 'top-bonus-channel', amount: '5' });
  await groupCommand.handleInteraction(submitRemove);
  assert.ok(JSON.stringify(submitRemove.state.reply?.components?.map(component => component.toJSON())).includes(`groups_bonus_confirm:group-remove:${groupId}:5`), 'group-point removals require a confirmation');
  const confirm = mockGroupInteraction({ customId: `groups_bonus_confirm:group-remove:${groupId}:5`, guild, channelId: 'top-bonus-channel', message: { id: 'top-bonus-confirm-once' } });
  await groupCommand.handleInteraction(confirm);
  assert.equal(Number((await gm.getGroup(guildId, groupId)).points), 30);
  assert.deepEqual(confirm.state.update?.components, [], 'confirmation controls are removed before the point deduction');
  const replay = mockGroupInteraction({ customId: `groups_bonus_confirm:group-remove:${groupId}:5`, guild, channelId: 'top-bonus-channel', message: { id: 'top-bonus-confirm-once' } });
  await groupCommand.handleInteraction(replay);
  assert.equal(Number((await gm.getGroup(guildId, groupId)).points), 30, 'a used confirmation cannot deduct points twice');


  const openMemberAdd = mockGroupInteraction({ customId: 'groups_bonus:member-add', guild, channelId: 'top-bonus-channel' });
  await groupCommand.handleInteraction(openMemberAdd);
  const selectMemberAddGroup = mockGroupInteraction({ customId: 'groups_bonus_select:member-add:0', guild, channelId: 'top-bonus-channel', values: [String(groupId)] });
  await groupCommand.handleInteraction(selectMemberAddGroup);
  assert.ok(JSON.stringify(selectMemberAddGroup.state.update?.components?.map(component => component.toJSON())).includes(`groups_bonus_member_select:member-add:${groupId}`));
  const selectMemberAddUser = mockGroupInteraction({ customId: `groups_bonus_member_select:member-add:${groupId}`, guild, channelId: 'top-bonus-channel', values: [USER_A] });
  await groupCommand.handleInteraction(selectMemberAddUser);
  assert.equal(selectMemberAddUser.state.modal?.custom_id, `groups_bonus_modal:member-add:${groupId}:${USER_A}`);
  const submitMemberAdd = mockGroupInteraction({ customId: `groups_bonus_modal:member-add:${groupId}:${USER_A}`, guild, channelId: 'top-bonus-channel', amount: '12' });
  await groupCommand.handleInteraction(submitMemberAdd);
  assert.equal(Number((await gm.listMemberPoints(guildId, groupId, 10)).find(row => row.user_id === USER_A).points), 12);
  assert.equal(Number((await gm.getGroup(guildId, groupId)).points), 42);

  const openMemberRemove = mockGroupInteraction({ customId: 'groups_bonus:member-remove', guild, channelId: 'top-bonus-channel' });
  await groupCommand.handleInteraction(openMemberRemove);
  const selectMemberRemoveGroup = mockGroupInteraction({ customId: 'groups_bonus_select:member-remove:0', guild, channelId: 'top-bonus-channel', values: [String(groupId)] });
  await groupCommand.handleInteraction(selectMemberRemoveGroup);
  const selectMemberRemoveUser = mockGroupInteraction({ customId: `groups_bonus_member_select:member-remove:${groupId}`, guild, channelId: 'top-bonus-channel', values: [USER_A] });
  await groupCommand.handleInteraction(selectMemberRemoveUser);
  const submitMemberRemove = mockGroupInteraction({ customId: `groups_bonus_modal:member-remove:${groupId}:${USER_A}`, guild, channelId: 'top-bonus-channel', amount: '2' });
  await groupCommand.handleInteraction(submitMemberRemove);
  assert.ok(JSON.stringify(submitMemberRemove.state.reply?.components?.map(component => component.toJSON())).includes(`groups_bonus_confirm:member-remove:${groupId}:2:${USER_A}`));
  const confirmMemberRemove = mockGroupInteraction({ customId: `groups_bonus_confirm:member-remove:${groupId}:2:${USER_A}`, guild, channelId: 'top-bonus-channel', message: { id: 'top-bonus-member-confirm-once' } });
  await groupCommand.handleInteraction(confirmMemberRemove);
  assert.equal(Number((await gm.listMemberPoints(guildId, groupId, 10)).find(row => row.user_id === USER_A).points), 10);
  assert.equal(Number((await gm.getGroup(guildId, groupId)).points), 40);

  const openAllAdd = mockGroupInteraction({ customId: 'groups_bonus:all-add', guild, channelId: 'top-bonus-channel' });
  await groupCommand.handleInteraction(openAllAdd);
  assert.equal(openAllAdd.state.modal?.custom_id, 'groups_bonus_modal:all-add:all');
  const submitAllAdd = mockGroupInteraction({ customId: 'groups_bonus_modal:all-add:all', guild, channelId: 'top-bonus-channel', amount: '7' });
  await groupCommand.handleInteraction(submitAllAdd);
  assert.equal(Number((await gm.getGroup(guildId, groupId)).points), 47);

  const openAllRemove = mockGroupInteraction({ customId: 'groups_bonus:all-remove', guild, channelId: 'top-bonus-channel' });
  await groupCommand.handleInteraction(openAllRemove);
  const submitAllRemove = mockGroupInteraction({ customId: 'groups_bonus_modal:all-remove:all', guild, channelId: 'top-bonus-channel', amount: '5' });
  await groupCommand.handleInteraction(submitAllRemove);
  assert.ok(JSON.stringify(submitAllRemove.state.reply?.components?.map(component => component.toJSON())).includes('groups_bonus_confirm:all-remove:5'));
  const confirmAllRemove = mockGroupInteraction({ customId: 'groups_bonus_confirm:all-remove:5', guild, channelId: 'top-bonus-channel', message: { id: 'top-bonus-all-confirm-once' } });
  await groupCommand.handleInteraction(confirmAllRemove);
  assert.equal(Number((await gm.getGroup(guildId, groupId)).points), 42);

  const openCancelRemove = mockGroupInteraction({ customId: 'groups_bonus:group-remove', guild, channelId: 'top-bonus-channel' });
  await groupCommand.handleInteraction(openCancelRemove);
  const selectCancelGroup = mockGroupInteraction({ customId: 'groups_bonus_select:group-remove:0', guild, channelId: 'top-bonus-channel', values: [String(groupId)] });
  await groupCommand.handleInteraction(selectCancelGroup);
  const submitCancelRemove = mockGroupInteraction({ customId: `groups_bonus_modal:group-remove:${groupId}`, guild, channelId: 'top-bonus-channel', amount: '1' });
  await groupCommand.handleInteraction(submitCancelRemove);
  const cancel = mockGroupInteraction({ customId: 'groups_bonus:cancel', guild, message: { id: 'top-bonus-cancel-once' } });
  await groupCommand.handleInteraction(cancel);
  const canceledReplay = mockGroupInteraction({ customId: `groups_bonus_confirm:group-remove:${groupId}:1`, guild, message: { id: 'top-bonus-cancel-once' } });
  await groupCommand.handleInteraction(canceledReplay);
  assert.equal(Number((await gm.getGroup(guildId, groupId)).points), 42, 'cancel consumes the confirmation and prevents a later stale deduction');

  const rank = mockGroupInteraction({ customId: 'groups_top:rank', guild, userId: USER_A, channelId: 'top-bonus-channel' });
  await groupCommand.handleInteraction(rank);
  assert.equal(rank.state.editReply?.files?.length, 1, 'My Rank responds with a private image for the member\'s group');
  assert.ok(rank.state.editReply.files[0].name.includes('my-group-rank'), 'My Rank renders a group-specific rank image instead of the public top-board image');
  const myGroup = mockGroupInteraction({ customId: 'groups_top:group', guild, userId: USER_A, channelId: 'top-bonus-channel' });
  await groupCommand.handleInteraction(myGroup);
  const myGroupJson = JSON.stringify(myGroup.state.editReply);
  assert.ok(myGroupJson.includes('groups_top:leave:' + groupId), 'My Group provides a Leave action');
  assert.ok(myGroupJson.includes('Created:') && !myGroupJson.includes('تاريخ الإنشاء'), 'My Group uses structured text and an English date label');

  const leaveRequest = mockGroupInteraction({ customId: `groups_top:leave:${groupId}`, guild, userId: USER_A, channelId: 'top-bonus-channel' });
  await groupCommand.handleInteraction(leaveRequest);
  assert.ok(JSON.stringify(leaveRequest.state.update).includes(`groups_top:leave-confirm:${groupId}`), 'Leave requires explicit confirmation');
  const leavingMember = { id: USER_A, roles: { cache: { has: () => false }, add: async () => {}, remove: async () => {} } };
  guild.members.fetch = async id => String(id) === USER_A ? leavingMember : null;
  const leaveConfirm = mockGroupInteraction({ customId: `groups_top:leave-confirm:${groupId}`, guild, userId: USER_A, channelId: 'top-bonus-channel' });
  await groupCommand.handleInteraction(leaveConfirm);
  assert.equal((await gm.getGroup(guildId, groupId)).memberIds.includes(USER_A), false, 'confirmed Leave removes the member from the group');
  assert.ok(leaveConfirm.state.editReply?.components?.length, 'confirmed Leave returns a completion card');
  const refresh = mockGroupInteraction({ customId: 'groups_top:refresh', guild, channelId: 'top-bonus-channel' });
  refresh.message = { edit: async payload => { refresh.state.messageEdit = payload; return payload; } };
  await groupCommand.handleInteraction(refresh);
  assert.equal(refresh.state.deferredUpdate, true);
  assert.equal(refresh.state.messageEdit?.files?.length, 1, 'Refresh updates the public image message');
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
    await testGroupCommandGuideAndMusicApi();
    await testCreateGroupRoleDefaults();
    await testDashboardPublishers();
    await testSetupDashboardSerialization();
    await testDeleteCommandFlow();
    await testMembershipLimitsAndBlockedUsers();
    await testPointsAndReset();
    await testInternalCommandParser();
    await testManualGroupPointAdjustments();
    await testTopBonusControls();
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
