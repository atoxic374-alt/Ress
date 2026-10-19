function getResponsibilityPointEntries(pointState = {}) {
    const state = pointState && typeof pointState === 'object' ? pointState : {};
    const claims = state.__shortcutClaims;
    const audit = Array.isArray(state.__audit)
        ? state.__audit.filter((entry) => entry?.source === 'shortcut_take')
        : [];
    const auditedIds = new Set(audit.map((entry) => String(entry.id || '')));
    const hasClaims = claims && typeof claims === 'object' && !Array.isArray(claims)
        && Object.keys(claims).length > 0;

    const entries = hasClaims
        ? Object.values(claims)
            .filter((claim) => claim && (
                claim.pointsAwarded === true
                || (claim.pointsAwarded !== false && auditedIds.has(String(claim.entryId || '')))
            ))
            .map((claim) => ({
                userId: claim.userId,
                responsibilityName: claim.responsibilityName,
                at: claim.at,
                delta: 1
            }))
        : audit.map((entry) => ({
            userId: entry.targetId || entry.userId,
            responsibilityName: entry.respName || entry.responsibilityName,
            at: entry.at || entry.id,
            delta: entry.delta
        }));

    return entries.filter((entry) => {
        const userId = String(entry?.userId || '').trim();
        const delta = Number(entry?.delta || 0);
        return Boolean(userId) && Number.isFinite(delta) && delta > 0;
    }).map((entry) => ({
        ...entry,
        userId: String(entry.userId),
        responsibilityName: String(entry.responsibilityName || ''),
        delta: Number(entry.delta)
    }));
}

function getUserResponsibilityPointTotals(pointState = {}, userId) {
    const targetId = String(userId || '').trim();
    const totals = {};
    if (!targetId) return totals;

    for (const entry of getResponsibilityPointEntries(pointState)) {
        if (entry.userId !== targetId || !entry.responsibilityName) continue;
        totals[entry.responsibilityName] = (totals[entry.responsibilityName] || 0) + entry.delta;
    }
    return totals;
}

module.exports = { getResponsibilityPointEntries, getUserResponsibilityPointTotals };
