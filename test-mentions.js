const assert = require('node:assert/strict');
const {
  normalizeDiscordId,
  normalizeMentionableIds,
  userMention,
  allowedMentions
} = require('./utils/mentions');

const validId = '123456789012345678';
assert.equal(normalizeDiscordId(validId), validId);
assert.equal(normalizeDiscordId(`<@${validId}>`), validId);
assert.equal(normalizeDiscordId(`<@!${validId}>`), validId);
assert.equal(normalizeDiscordId({ id: validId }), validId);
assert.equal(normalizeDiscordId('idالشخص'), null);
assert.equal(userMention(validId), `<@${validId}>`);
assert.equal(userMention('idالشخص'), null);
assert.deepEqual(normalizeMentionableIds([validId, `<@!${validId}>`, 'idالشخص']), [validId]);
assert.deepEqual(allowedMentions.parse, ['users', 'roles']);
console.log('mention tests passed');
