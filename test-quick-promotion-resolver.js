const assert = require('node:assert/strict');
const { getQuickPromotionTypes, resolveQuickPromotion } = require('./utils/quickPromotionResolver');

const roles = {
    admin: { id: 'admin-id', name: 'admin', position: 1 },
    c: { id: 'c-id', name: 'C', position: 2 },
    b: { id: 'b-id', name: 'B', position: 3 },
    a: { id: 'a-id', name: 'A', position: 4 },
    v2: { id: 'v2-id', name: 'V2 Moderator', position: 5 },
    v1: { id: 'v1-id', name: 'V1 Moderator', position: 6 }
};
const adminRoleIds = Object.values(roles).map((role) => role.id);
const rankRoles = [roles.c, roles.b, roles.a];
const visualRoles = [roles.v2, roles.v1];

assert.deepEqual(getQuickPromotionTypes([roles.c, roles.v1], adminRoleIds, 'both'), {
    types: ['rank', 'visual'],
    missingTypes: []
});
assert.deepEqual(getQuickPromotionTypes([roles.c], adminRoleIds, 'both'), {
    types: ['rank'],
    missingTypes: ['visual']
});
assert.deepEqual(getQuickPromotionTypes([roles.admin], adminRoleIds, 'both'), {
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

// Generic admin only: promote to the first role of the chosen type.
const adminToFirstRank = resolve([roles.admin], 'rank');
assert.equal(adminToFirstRank.currentRole.id, roles.admin.id);
assert.equal(adminToFirstRank.newRole.id, roles.c.id);
assert.deepEqual(adminToFirstRank.rolesToRemove, [roles.admin.id]);
assert.equal(adminToFirstRank.startedFromOtherType, true);

const adminToSecondRank = resolve([roles.admin], 'rank', 'up', 2);
assert.equal(adminToSecondRank.newRole.id, roles.b.id);

const adminToFirstVisual = resolve([roles.admin], 'visual');
assert.equal(adminToFirstVisual.newRole.id, roles.v2.id);
assert.deepEqual(adminToFirstVisual.rolesToRemove, [roles.admin.id]);

const adminAndOtherTypeToRank = resolve([roles.admin, roles.v1], 'rank');
assert.equal(adminAndOtherTypeToRank.newRole.id, roles.c.id);
assert.deepEqual(adminAndOtherTypeToRank.rolesToRemove, [roles.admin.id, roles.v1.id]);

// Existing letter rank moves one step; the visual role remains untouched.
const rankAndVisual = resolve([roles.c, roles.v1], 'rank');
assert.equal(rankAndVisual.newRole.id, roles.b.id);
assert.deepEqual(rankAndVisual.rolesToRemove, [roles.c.id]);

// Existing visual rank moves one step; the letter rank remains untouched.
const visualAndRank = resolve([roles.v2, roles.a], 'visual');
assert.equal(visualAndRank.newRole.id, roles.v1.id);
assert.deepEqual(visualAndRank.rolesToRemove, [roles.v2.id]);

// If the member has only the opposite type, convert that role to the chosen type.
const visualToRank = resolve([roles.v1], 'rank');
assert.equal(visualToRank.newRole.id, roles.c.id);
assert.deepEqual(visualToRank.rolesToRemove, [roles.v1.id]);

const rankToVisual = resolve([roles.a], 'visual');
assert.equal(rankToVisual.newRole.id, roles.v2.id);
assert.deepEqual(rankToVisual.rolesToRemove, [roles.a.id]);

const regularPromotion = resolve([roles.c], 'rank');
assert.equal(regularPromotion.newRole.id, roles.b.id);
assert.equal(regularPromotion.startedFromOtherType, false);

const outOfRange = resolve([roles.a], 'rank');
assert.equal(outOfRange.error, 'out-of-range');

console.log('All quick promotion resolver tests passed.');
