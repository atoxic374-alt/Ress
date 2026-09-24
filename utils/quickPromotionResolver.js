function isGenericAdminRole(role) {
    return role.name.trim().toLowerCase() === 'admin';
}

function matchesPromotionType(role, selectedType) {
    if (isGenericAdminRole(role)) return false;
    return (role.name.length <= 3) === (selectedType === 'rank');
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

    // عند عدم وجود رتبة من النوع المختار في الترقية، استخدم الرتبة الإدارية
    // الحالية كنقطة انطلاق للتحويل إلى النوع المطلوب.
    const startingRole = !currentRole && selectedAction === 'up'
        ? memberRoles
            .filter((role) => adminRoleIds.includes(role.id) && (
                isGenericAdminRole(role) || !matchesPromotionType(role, selectedType)
            ))
            .sort((a, b) => b.position - a.position)[0] || null
        : null;
    const sourceRole = currentRole || startingRole;

    if (!sourceRole) {
        return { error: 'no-current-role' };
    }

    let targetIndex;
    if (startingRole) {
        // التحويل إلى النوع المختار يبدأ من الرتبة ذات المستوى الذي اختاره المستخدم.
        targetIndex = levels - 1;
    } else {
        const signedLevels = selectedAction === 'up' ? levels : -levels;
        const currentIndex = availableRoles.findIndex((role) => role.id === sourceRole.id);
        targetIndex = currentIndex === -1
            ? availableRoles.findIndex((role) => role.position > sourceRole.position) +
                (signedLevels - (selectedAction === 'up' ? 1 : 0))
            : currentIndex + signedLevels;
    }

    if (targetIndex < 0 || targetIndex >= availableRoles.length) {
        return { error: 'out-of-range', currentRole: sourceRole };
    }

    const newRole = availableRoles[targetIndex];
    // احذف رتب النوع المختار فقط إذا كان موجودًا؛ عند التحويل تُزال رتبة المصدر.
    const rolesToRemove = memberRoles
        .filter((role) => adminRoleIds.includes(role.id) && (
            matchesPromotionType(role, selectedType) || Boolean(startingRole)
        ))
        .map((role) => role.id);

    return {
        currentRole: sourceRole,
        newRole,
        rolesToRemove,
        startedFromOtherType: Boolean(startingRole)
    };
}

module.exports = { getQuickPromotionTypes, resolveQuickPromotion };
