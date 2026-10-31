const assert = require('node:assert/strict');
const { getAvailableQuickRoles, getQuickPromotionTypes, resolveQuickPromotion } = require('./utils/quickPromotionResolver');
const { getPromotionRoleType } = require('./utils/promotionRoleTypes');

const roles = {
    admin: { id: 'admin-id', name: 'admin', position: 1 },
    c: { id: 'c-id', name: 'C', position: 2 },
    b: { id: 'b-id', name: 'B', position: 3 },
    a: { id: 'a-id', name: 'A', position: 4 },
    v2: { id: 'v2-id', name: 'V2 Moderator', position: 5 },
    v1: { id: 'v1-id', name: 'V1 Moderator', position: 6 },
    threeChars: { id: 'three-id', name: 'ABC', position: 7 }
};
const adminRoleIds = Object.values(roles).map((role) => role.id);
const rankRoles = [roles.c, roles.b, roles.a];
const visualRoles = [roles.admin, roles.v2, roles.v1];

assert.equal(getPromotionRoleType('AB'), 'letter');
assert.equal(getPromotionRoleType('ABC'), null);
assert.equal(getPromotionRoleType('ABCD'), 'phenomena');
assert.equal(getPromotionRoleType('أب'), 'letter');
assert.equal(getPromotionRoleType('أبو'), null);
assert.equal(getPromotionRoleType('أبجد'), 'phenomena');
assert.equal(getPromotionRoleType(''), null);
assert.deepEqual(getAvailableQuickRoles(Object.values(roles), 'visual').map(role => role.id), [roles.admin.id, roles.v2.id, roles.v1.id]);
assert.deepEqual(getAvailableQuickRoles(Object.values(roles), 'rank').map(role => role.id), [roles.c.id, roles.b.id, roles.a.id]);

assert.deepEqual(getQuickPromotionTypes([roles.c, roles.v1], adminRoleIds, 'both'), {
    types: ['rank', 'visual'],
    missingTypes: []
});
assert.deepEqual(getQuickPromotionTypes([roles.c], adminRoleIds, 'both'), {
    types: ['rank'],
    missingTypes: ['visual']
});
assert.deepEqual(getQuickPromotionTypes([roles.admin], adminRoleIds, 'both'), {
    types: ['visual'],
    missingTypes: ['rank']
});
assert.deepEqual(getQuickPromotionTypes([roles.threeChars], adminRoleIds, 'both'), {
    types: [],
    missingTypes: ['rank', 'visual']
});

function resolve(memberRoles, selectedType, selectedAction = 'up', levels = 1) {
    return resolveQuickPromotion({
        memberRoles,
        adminRoleIds,
        availableRoles: selectedType === 'rank' ? rankRoles : visualRoles,
        selectedType,
        selectedAction,
        levels
    });
}

// A letter promotion starts at its own first role and preserves the visual role.
const adminToFirstRank = resolve([roles.admin], 'rank');
assert.equal(adminToFirstRank.currentRole, null);
assert.equal(adminToFirstRank.newRole.id, roles.c.id);
assert.deepEqual(adminToFirstRank.rolesToRemove, []);

const adminToSecondRank = resolve([roles.admin], 'rank', 'up', 2);
assert.equal(adminToSecondRank.newRole.id, roles.b.id);

const adminToFirstVisual = resolve([roles.admin], 'visual');
assert.equal(adminToFirstVisual.currentRole.id, roles.admin.id);
assert.equal(adminToFirstVisual.newRole.id, roles.v2.id);
assert.deepEqual(adminToFirstVisual.rolesToRemove, [roles.admin.id]);

// Existing letter rank moves one step; the visual role remains untouched.
const rankAndVisual = resolve([roles.c, roles.v1], 'rank');
assert.equal(rankAndVisual.newRole.id, roles.b.id);
assert.deepEqual(rankAndVisual.rolesToRemove, [roles.c.id]);

// Existing visual rank moves one step; the letter rank remains untouched.
const visualAndRank = resolve([roles.v2, roles.a], 'visual');
assert.equal(visualAndRank.newRole.id, roles.v1.id);
assert.deepEqual(visualAndRank.rolesToRemove, [roles.v2.id]);

// If the member has only the opposite or an unclassified role, preserve it.
const visualToRank = resolve([roles.v1], 'rank');
assert.equal(visualToRank.newRole.id, roles.c.id);
assert.deepEqual(visualToRank.rolesToRemove, []);
const threeCharToRank = resolve([roles.threeChars], 'rank');
assert.equal(threeCharToRank.newRole.id, roles.c.id);
assert.deepEqual(threeCharToRank.rolesToRemove, []);

const outOfRange = resolve([roles.a], 'rank');
assert.equal(outOfRange.error, 'out-of-range');

console.log('All quick promotion resolver tests passed.');
