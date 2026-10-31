function getPromotionRoleType(roleOrName) {
    const name = typeof roleOrName === 'string'
        ? roleOrName
        : roleOrName?.name;
    const length = Array.from(String(name || '').trim()).length;

    if (length > 0 && length < 3) return 'letter';
    if (length > 3) return 'phenomena';
    return null;
}

function matchesPromotionRoleType(roleOrName, type) {
    return getPromotionRoleType(roleOrName) === type;
}

module.exports = { getPromotionRoleType, matchesPromotionRoleType };
