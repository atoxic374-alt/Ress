const { getPromotionRoleType } = require('./promotionRoleTypes');

function matchesPromotionType(role, selectedType) {
    const roleType = selectedType === 'rank'
        ? 'letter'
        : selectedType === 'visual'
            ? 'phenomena'
            : selectedType;
    return getPromotionRoleType(role) === roleType;
}

function getAvailableQuickRoles(adminRoles, selectedType) {
    return adminRoles.filter((role) => matchesPromotionType(role, selectedType));
}

function getQuickPromotionTypes(memberRoles, adminRoleIds, selectedType) {
    if (selectedType !== 'both') {
        return { types: [selectedType], missingTypes: [] };
    }

    const adminRoles = memberRoles.filter((role) => adminRoleIds.includes(role.id));
    const hasRank = adminRoles.some((role) => matchesPromotionType(role, 'rank'));
    const hasVisual = adminRoles.some((role) => matchesPromotionType(role, 'visual'));

    return {
        types: ['rank', 'visual'].filter((type) => type === 'rank' ? hasRank : hasVisual),
        missingTypes: ['rank', 'visual'].filter((type) => type === 'rank' ? !hasRank : !hasVisual)
    };
}

function resolveQuickPromotion({
    memberRoles,
    adminRoleIds,
    availableRoles,
    selectedType,
    selectedAction,
    levels
}) {
    const currentRole = memberRoles
        .filter((role) => adminRoleIds.includes(role.id) && matchesPromotionType(role, selectedType))
        .sort((a, b) => b.position - a.position)[0] || null;

    // ابدأ من أول مستوى في الفئة المطلوبة عند عدم وجود رول من النوع نفسه؛
    // لا تستخدم رول ظواهر كنقطة انطلاق لترقية حرف أو العكس.
    if (!currentRole && selectedAction !== 'up') {
        return { error: 'no-current-role' };
    }

    const currentIndex = currentRole
        ? availableRoles.findIndex((role) => role.id === currentRole.id)
        : -1;
    const targetIndex = !currentRole
        ? levels - 1
        : currentIndex === -1
            ? availableRoles.findIndex((role) => role.position > currentRole.position) + (levels - 1)
            : currentIndex + levels;

    if (targetIndex < 0 || targetIndex >= availableRoles.length) {
        return { error: 'out-of-range', currentRole };
    }

    const newRole = availableRoles[targetIndex];
    const rolesToRemove = memberRoles
        .filter((role) => adminRoleIds.includes(role.id) && matchesPromotionType(role, selectedType))
        .map((role) => role.id);

    return {
        currentRole,
        newRole,
        rolesToRemove,
        startedFromOtherType: false
    };
}

module.exports = { getAvailableQuickRoles, getQuickPromotionTypes, resolveQuickPromotion };
