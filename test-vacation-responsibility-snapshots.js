const assert = require('node:assert/strict');
const Module = require('node:module');

const vacationManagerPath = require.resolve('./utils/vacationManager');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'discord.js') return { EmbedBuilder: class EmbedBuilder {} };
    if (request === './colorManager' && parent?.filename === vacationManagerPath) return {};
    return originalLoad.call(this, request, parent, isMain);
};

let vacationManager;
try {
    vacationManager = require('./utils/vacationManager');
} finally {
    Module._load = originalLoad;
}

const userId = '10000000000000001';
const roleA = '20000000000000001';
const roleB = '20000000000000002';
const roleC = '20000000000000003';
const otherUserId = '30000000000000001';

const captured = vacationManager.captureResponsibilityAssignments({
    Alpha: {
        responsibles: ['40000000000000001', `<@!${userId}>`],
        roles: [`<@&${roleA}>`]
    },
    Beta: {
        responsibles: [userId],
        roleIds: [roleB],
        roleId: roleC
    },
    Gamma: {
        responsibles: [`<@${otherUserId}>`],
        roles: [roleC]
    }
}, userId);

assert.deepEqual(captured, [
    { name: 'Alpha', index: 1, roleIds: [roleA] },
    { name: 'Beta', index: 0, roleIds: [roleB, roleC] }
]);

const merged = vacationManager.mergeResponsibilityAssignments(
    [{ name: 'Alpha', index: 1, roleIds: [roleA] }],
    [
        { name: 'Alpha', index: 4, roleIds: [roleB] },
        { name: 'Beta', index: 0, roleIds: [roleC] }
    ]
);

assert.deepEqual(merged, [
    { name: 'Alpha', index: 1, roleIds: [roleA, roleB] },
    { name: 'Beta', index: 0, roleIds: [roleC] }
]);

console.log('All vacation responsibility snapshot tests passed.');
