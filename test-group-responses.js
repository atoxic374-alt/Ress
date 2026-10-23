'use strict';

const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');
const { normalizeGroupText, responsePayload } = require('./utils/groupResponses');

assert.equal(normalizeGroupText('القروب: الاسم'), 'القروب : الاسم');
assert.equal(normalizeGroupText('الرتبة: <@&123>'), 'الرتبة : <@&123>');
assert.equal(normalizeGroupText('تم الحفظ : بنجاح'), 'تم الحفظ : بنجاح');
assert.equal(normalizeGroupText('رابط https://example.com/a:b'), 'رابط https://example.com/a:b');
assert.equal(normalizeGroupText('سطر أول   \n\n\nسطر ثانٍ'), 'سطر أول\n\nسطر ثانٍ');

const payload = responsePayload({ content: 'تم تحديث القروب.', ephemeral: true });
assert.equal(typeof payload.content, 'undefined');
assert.ok(Array.isArray(payload.components));
assert.ok((payload.flags & MessageFlags.IsComponentsV2) === MessageFlags.IsComponentsV2);
assert.equal(payload.allowedMentions.parse.length, 0);
assert.equal(payload.components[0].components[0].content, 'تم تحديث القروب.');

const existingV2 = responsePayload({
  components: [{
    type: 17,
    components: [{ type: 10, content: 'إعداد القروب : مكتمل' }]
  }],
  flags: MessageFlags.IsComponentsV2
});
assert.equal(existingV2.components[0].components[0].content, 'إعداد القروب : مكتمل');

console.log('Group response formatter tests passed.');
