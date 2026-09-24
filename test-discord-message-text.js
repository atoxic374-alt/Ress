const assert = require('node:assert/strict');
const { splitDiscordText, limitDiscordContent } = require('./utils/discordMessageText');

const split = splitDiscordText(`${'أ'.repeat(4500)}\n${'ب'.repeat(2500)}`);
assert.ok(split.length >= 4);
assert.ok(split.every((part) => part.length <= 1900));
assert.equal(split.join('').replace(/\s/g, '').length, 7000);

const exactMaximumSplit = splitDiscordText('z'.repeat(4500), 2000);
assert.ok(exactMaximumSplit.length >= 3);
assert.ok(exactMaximumSplit.every((part) => part.length <= 2000));

const capped = limitDiscordContent('x'.repeat(10000));
assert.ok(capped.length <= 1900);
assert.ok(capped.includes('اختُصر النص'));

assert.deepEqual(splitDiscordText(''), [' ']);
console.log('All Discord message text tests passed.');
