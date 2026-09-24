function resolveQuickPromotion({
    memberRoles,
    adminRoleIds,
    availableRoles,
    selectedType,
    selectedAction,
    levels
}) {
    const isRankPromotion = selectedType === 'rank';
    const isGenericAdminRole = (role) => role.name.trim().toLowerCase() === 'admin';
    const matchesSelectedType = (role) =>
        !isGenericAdminRole(role) && (role.name.length <= 3) === isRankPromotion;
    const highestPositionFirst = (a, b) => b.position - a.position;

    const currentRole = memberRoles
        .filter((role) => adminRoleIds.includes(role.id) && matchesSelectedType(role))
        .sort(highestPositionFirst)[0] || null;

    // إذا لم تكن لدى العضو رتبة من النوع المطلوب، تُستخدم رتبته الإدارية
    // الحالية (ومنها admin) كنقطة انطلاق للنوع الذي اختاره المسؤول.
    const startingRole = !currentRole && selectedAction === 'up'
        ? memberRoles
            .filter((role) => adminRoleIds.includes(role.id) && (
                isGenericAdminRole(role) || !matchesSelectedType(role)
            ))
            .sort(highestPositionFirst)[0] || null
        : null;
    const sourceRole = currentRole || startingRole;

    if (!sourceRole) {
        return { error: 'no-current-role' };
    }

    let targetIndex;
    if (startingRole) {
        // التحويل بين النوعين يبدأ من أول رتبة من النوع المختار.
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
    // إذا كان النوع المختار موجودًا، احذف رتب هذا النوع وحدها. أما إذا لم
    // يكن موجودًا، فاستبدل رتب المصدر بالنوع الجديد المختار.
    const rolesToRemove = memberRoles
        .filter((role) => adminRoleIds.includes(role.id) && (
            matchesSelectedType(role) || Boolean(startingRole)
        ))
        .map((role) => role.id);

    return {
        currentRole: sourceRole,
        newRole,
        rolesToRemove,
        startedFromOtherType: Boolean(startingRole)
    };
}

module.exports = { resolveQuickPromotion };
